import type { Pool } from "pg";
import {
  seedTasks,
  claimTasks,
  failTask,
  taskCounts,
  RECORD_STAGES,
  type TaskClaim,
  type RecordStage,
} from "../../sql/ingestion-tasks.js";
import { Execution, errorDetails } from "./execution.js";
import { LlmError } from "./providers/llm.js";
export function recordFailure(error: unknown) {
  // Unknown code/database/provider-shape failures stop globally. Only recognized record validation is isolated.
  if (error instanceof LlmError)
    return (
      !error.retryable &&
      !error.status &&
      /Completion truncated|Empty final|validation|record_id mismatch/i.test(
        error.message,
      )
    );
  return (
    error instanceof Error &&
    /record_id mismatch|normalization (?:output|schema)|Invalid normalization|unsupported semantic|Invalid (?:record|date)|Missing evidence/i.test(
      error.message,
    )
  );
}
export async function runRecordScheduler(options: {
  db: Pool;
  ex: Execution;
  run: string;
  from?: string;
  stopAfter?: string;
  shadow: boolean;
  concurrency: number;
  finiteBudget: boolean;
  execute: (claim: TaskClaim) => Promise<void>;
}) {
  const { db, ex, run } = options;
  const selectedFrom = RECORD_STAGES.indexOf(options.from as RecordStage);
  const from =
    options.from && selectedFrom < 0
      ? RECORD_STAGES.length
      : Math.max(0, selectedFrom);
  let last = RECORD_STAGES.indexOf(options.stopAfter as RecordStage);
  if (last < 0) last = RECORD_STAGES.length - 1;
  if (options.shadow) last = 0;
  await seedTasks(db, run, ex.id, from);
  const capacity: Record<RecordStage, number> = {
    normalize: options.finiteBudget ? 1 : options.concurrency,
    geocode: 1,
    embed: 32,
    match: 1,
    canonical: 1,
    verify: 2,
  };
  const active = new Map<RecordStage, Set<Promise<void>>>(
    RECORD_STAGES.map((s) => [s, new Set()]),
  );
  let fatal: unknown,
    pressure = false,
    revision = 0;
  const consecutiveRecordFailures = new Map<RecordStage, number>();
  try {
    for (;;) {
      const before = revision;
      let launched = 0;
      ex.check();
      if (!ex.stopped && !fatal) {
        const backlog = (
          await db.query(
            `SELECT count(*)::int AS n FROM research_ingest_tasks n JOIN research_ingest_tasks v USING(run_id,source_record_id)
        WHERE n.run_id=$1 AND n.stage='normalize' AND n.state IN ('succeeded','reused') AND v.stage='verify' AND v.state='pending'
        AND NOT EXISTS(SELECT 1 FROM research_ingest_tasks b WHERE b.run_id=n.run_id AND b.source_record_id=n.source_record_id AND b.state='quarantined')`,
            [run],
          )
        ).rows[0].n;
        pressure = pressure ? backlog >= 500 : backlog >= 1000;
        const state = {
          version: 2,
          backpressure: pressure,
          downstream_backlog: backlog,
          active: Object.fromEntries([...active].map(([s, p]) => [s, p.size])),
        };
        await db.query(
          `UPDATE research_ingest_runs SET current_stage=COALESCE((SELECT stage FROM research_ingest_tasks WHERE run_id=$1 AND state IN ('pending','running') ORDER BY rank LIMIT 1),'verify'),
        counters=jsonb_set(counters,'{scheduler}',$2::jsonb) WHERE id=$1`,
          [run, JSON.stringify(state)],
        );
        // Drain the ready downstream backlog before admitting additional upstream work.
        for (const stage of [...RECORD_STAGES].reverse()) {
          const rank = RECORD_STAGES.indexOf(stage);
          if (
            rank < from ||
            rank > last ||
            (stage === "normalize" && pressure) ||
            ex.stopped ||
            fatal
          )
            continue;
          const set = active.get(stage)!;
          const available = capacity[stage] - set.size;
          if (available <= 0) continue;
          const claims = await claimTasks(db, run, ex.id, stage, available);
          for (const claim of claims) {
            launched++;
            const work = options
              .execute(claim)
              .then(() => {
                consecutiveRecordFailures.set(stage, 0);
              })
              .catch(async (error) => {
                const detail = errorDetails(error);
                if (detail.code === "ingest_paused") {
                  await failTask(db, claim, detail, false);
                  return;
                }
                const quarantine = recordFailure(error);
                try {
                  await failTask(db, claim, detail, quarantine);
                } catch (failure) {
                  fatal ??= failure;
                  ex.stopped = true;
                  ex.abortController.abort(failure);
                  return;
                }
                if (!quarantine) {
                  fatal ??= error;
                  ex.stopped = true;
                  ex.stopReason = "global_stage_failure";
                } else {
                  const failures =
                    (consecutiveRecordFailures.get(stage) ?? 0) + 1;
                  consecutiveRecordFailures.set(stage, failures);
                  if (failures >= 10) {
                    fatal ??= Object.assign(
                      new Error(
                        `Ten consecutive record validation failures in ${stage}; inspect the source mapping, prompt and provider output before resuming`,
                      ),
                      { code: "systemic_record_failure" },
                    );
                    ex.stopped = true;
                    ex.stopReason = "systemic_record_failure";
                  }
                }
              })
              .finally(() => {
                set.delete(work);
                revision++;
              });
            set.add(work);
          }
        }
      }
      const pending = [...active.values()].flatMap((s) => [...s]);
      if (!pending.length) {
        if (launched) continue;
        break;
      }
      if (revision !== before) continue;
      await Promise.race(pending);
    }
  } catch (error) {
    fatal ??= error;
    ex.stopped = true;
    ex.abortController.abort(error);
  }
  await Promise.allSettled([...active.values()].flatMap((s) => [...s]));
  if (fatal) throw fatal;
  const counts = await taskCounts(db, run);
  return {
    counts,
    partial: counts.some((x) => x.state === "quarantined"),
    budget: counts.some((x) => x.state === "waiting_budget"),
    paused: ex.stopped || last < RECORD_STAGES.length - 1,
  };
}
