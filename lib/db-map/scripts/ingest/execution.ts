import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import type { Pool, PoolClient } from "pg";
import { admitWorker } from "../../sql/ingestion-control.js";

export type Outcome =
  | "succeeded"
  | "reused"
  | "skipped"
  | "blocked"
  | "waiting_budget"
  | "paused";
export interface AttemptResult {
  status: Outcome;
  [key: string]: unknown;
}
const context = new AsyncLocalStorage<{
  runId: string;
  attemptId: string;
  execution: Execution;
}>();
export const currentAttempt = () => context.getStore();
export const errorDetails = (error: unknown) => ({
  name: error instanceof Error ? error.name : "Error",
  message: error instanceof Error ? error.message : String(error),
  stack: error instanceof Error ? error.stack : undefined,
  code: (error as { code?: string })?.code,
});

/** Session lock is held for the entire invocation, including provider calls. */
export async function lockSource(
  db: Pool,
  source: string,
): Promise<PoolClient> {
  const lock = await db.connect();
  try {
    await lock.query("SET statement_timeout = '10s'");
    await lock.query("BEGIN");
    await admitWorker(lock);
    const { rows } = await lock.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 91831)) AS locked",
      [source],
    );
    if (!rows[0]?.locked)
      throw new Error(`Another managed ingestion owns source ${source}`);
    await lock.query("COMMIT");
    return lock;
  } catch (error) {
    lock.release(true);
    throw error;
  }
}

export class Execution {
  stopped = false;
  stopReason = "";
  private timer?: NodeJS.Timeout;
  private pulse: Promise<void> = Promise.resolve();
  private heartbeatError?: unknown;
  private signals = 0;
  private completed = new Map<string, Map<string, AttemptResult>>();
  private closed = false;
  readonly logPath: string;
  private onSignal = (signal: string) => {
    this.journal("signal", { signal });
    this.stopped = true;
    this.stopReason = signal;
    console.warn(
      `${signal}: stopping after the current record; resume run ${this.runId}`,
    );
    if (++this.signals > 1) process.exit(signal === "SIGINT" ? 130 : 143);
  };
  constructor(
    readonly db: Pool,
    readonly runId: string,
    readonly id: string,
    private lock: PoolClient,
  ) {
    const directory = fileURLToPath(
      new URL("../../.ingest-logs/", import.meta.url),
    );
    this.logPath = `${directory}${runId}-${id}.jsonl`;
    try {
      mkdirSync(directory, { recursive: true });
    } catch (error) {
      console.warn(
        "Could not create local ingest journal:",
        errorDetails(error).message,
      );
    }
    this.journal("execution_started", { host: hostname(), pid: process.pid });
  }
  private journal(event: string, details: unknown) {
    try {
      appendFileSync(
        this.logPath,
        JSON.stringify({
          at: new Date().toISOString(),
          run_id: this.runId,
          execution_id: this.id,
          event,
          details,
        }) + "\n",
      );
    } catch (error) {
      console.warn(
        "Could not write local ingest journal:",
        errorDetails(error).message,
      );
    }
  }

  static async start(
    db: Pool,
    runId: string,
    options: unknown,
    lock: PoolClient,
  ): Promise<Execution> {
    let executionId: string;
    await lock.query("BEGIN");
    try {
      // Owning the source session lock proves no other managed execution can still run it.
      await lock.query(
        `UPDATE research_ingest_attempts SET status='interrupted', finished_at=now(),
      error=jsonb_build_object('message','Previous execution lost its source lock; exact termination cause unknown')
      WHERE run_id=$1 AND status='running'`,
        [runId],
      );
      await lock.query(
        `UPDATE research_ingest_executions SET status='interrupted', finished_at=now(),
      stop_reason='source_lock_recovered' WHERE run_id=$1 AND status='running'`,
        [runId],
      );
      const { rows } = await lock.query(
        `INSERT INTO research_ingest_executions(run_id,host,pid,options)
      VALUES($1,$2,$3,$4) RETURNING id`,
        [runId, hostname(), process.pid, JSON.stringify(options)],
      );
      await lock.query(
        `UPDATE research_ingest_runs SET status='running', stop_requested=false,
      stop_reason=NULL, fatal_error=NULL, completed_at=NULL, stopped_at=NULL, verified_at=NULL, heartbeat_at=now()
      WHERE id=$1`,
        [runId],
      );
      executionId = rows[0].id;
      await lock.query("COMMIT");
    } catch (error) {
      await lock.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    const execution = new Execution(db, runId, executionId, lock);
    // Losing this connection means the source lock is gone: never continue writing unlocked.
    lock.on("error", () => {
      console.error("Ingestion source lock lost; exiting for recovery");
      process.exit(1);
    });
    execution.timer = setInterval(() => {
      execution.pulse = execution.pulse
        .then(() => execution.heartbeat())
        .catch((error) => {
          execution.journal("heartbeat_failed", errorDetails(error));
          execution.heartbeatError = error;
          execution.stopped = true;
          execution.stopReason = "heartbeat_failed";
        });
    }, 5000);
    execution.timer.unref();
    process.on("SIGINT", execution.onSignal);
    process.on("SIGTERM", execution.onSignal);
    return execution;
  }
  async heartbeat() {
    const { rows } = await this.lock.query(
      `UPDATE research_ingest_runs SET heartbeat_at=now()
      WHERE id=$1 RETURNING stop_requested OR
        (SELECT maintenance FROM research_ingest_control WHERE singleton) AS stop_requested`,
      [this.runId],
    );
    await this.lock.query(
      "UPDATE research_ingest_executions SET heartbeat_at=now() WHERE id=$1",
      [this.id],
    );
    if (rows[0]?.stop_requested) {
      this.stopped = true;
      this.stopReason ||= "pause_requested";
    }
  }
  check() {
    if (this.heartbeatError) throw this.heartbeatError;
  }

  /** One durable append per reused record, inserted together without re-running its stage. */
  async reuseBatch(
    stage: string,
    items: Array<{ input: Record<string, unknown>; output: AttemptResult }>,
  ) {
    this.check();
    if (!items.length) return 0;
    this.journal("reuse_batch_start", { stage, count: items.length });
    const { rowCount } = await this.db.query(
      `INSERT INTO research_ingest_attempts(run_id,execution_id,stage,target_key,research_poi_id,source_record_id,input,output,status,finished_at)
      SELECT $1,$2,$3,x.input->>'source_record_id',(x.input->>'research_poi_id')::uuid,
        x.input->>'source_record_id',x.input,x.output,x.output->>'status',clock_timestamp()
      FROM jsonb_to_recordset($4::jsonb) x(input jsonb,output jsonb)
      JOIN research_ingest_run_items i ON i.run_id=$1 AND i.source_record_id=x.input->>'source_record_id'
      JOIN research_pois rp ON rp.id=i.research_poi_id AND rp.active_observation_id=i.observation_id AND rp.retired_at IS NULL
      WHERE ($3 <> 'normalize' OR (rp.active_normalization_id::text=x.output->>'normalization_id'
        AND rp.normalization_state IN ('active','degraded','rejected')))`,
      [this.runId, this.id, stage, JSON.stringify(items)],
    );
    this.completed.delete(stage);
    this.journal("reuse_batch_finished", { stage, count: rowCount });
    return rowCount ?? 0;
  }

  async attempt(
    stage: string,
    target: string,
    input: Record<string, unknown>,
    fn: () => Promise<AttemptResult>,
    reuse = true,
    canReuse?: (result: AttemptResult) => Promise<boolean>,
  ): Promise<AttemptResult> {
    this.check();
    if (reuse) {
      if (!this.completed.has(stage)) {
        const { rows } = await this.db.query(
          `SELECT * FROM (SELECT DISTINCT ON(target_key) target_key,status,output
          FROM research_ingest_attempts WHERE run_id=$1 AND stage=$2 ORDER BY target_key,started_at DESC,id DESC) latest
          WHERE status IN ('succeeded','reused','skipped')`,
          [this.runId, stage],
        );
        this.completed.set(
          stage,
          new Map(rows.map((row) => [row.target_key, row.output])),
        );
      }
      const result = this.completed.get(stage)?.get(target);
      if (result && (!canReuse || (await canReuse(result)))) return result;
    }
    this.journal("attempt_start", { stage, target, input });
    const { rows } = await this.db.query(
      `INSERT INTO research_ingest_attempts
      (run_id,execution_id,stage,target_key,research_poi_id,source_record_id,input)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [
        this.runId,
        this.id,
        stage,
        target,
        input.research_poi_id ?? null,
        input.source_record_id ?? null,
        JSON.stringify(input),
      ],
    );
    const id = rows[0].id;
    await this.db.query(
      "UPDATE research_ingest_runs SET current_stage=$2 WHERE id=$1",
      [this.runId, stage],
    );
    try {
      const result = await context.run(
        { runId: this.runId, attemptId: id, execution: this },
        fn,
      );
      this.journal("attempt_result", { id, stage, target, result });
      await this.db.query(
        `UPDATE research_ingest_attempts SET status=$2,output=$3,finished_at=now()
        WHERE id=$1 AND status='running'`,
        [id, result.status, JSON.stringify(result)],
      );
      if (["succeeded", "reused", "skipped"].includes(result.status))
        this.completed.get(stage)?.set(target, result);
      return result;
    } catch (error) {
      this.completed.get(stage)?.delete(target);
      this.journal("attempt_failed", {
        id,
        stage,
        target,
        error: errorDetails(error),
      });
      await this.db.query(
        `UPDATE research_ingest_attempts SET status='failed',error=$2,finished_at=now()
        WHERE id=$1 AND status='running'`,
        [id, JSON.stringify(errorDetails(error))],
      );
      throw error;
    }
  }
  async finish(status: string, reason: string, error?: unknown) {
    if (this.closed) return;
    this.closed = true;
    this.journal("execution_finished", {
      status,
      reason,
      error: error ? errorDetails(error) : undefined,
    });
    clearInterval(this.timer);
    await this.pulse;
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    try {
      await this.lock.query("BEGIN");
      await this.lock.query(
        `UPDATE research_ingest_executions SET status=$2,stop_reason=$3,
        error=$4,finished_at=now(),heartbeat_at=now() WHERE id=$1`,
        [
          this.id,
          status,
          reason,
          error ? JSON.stringify(errorDetails(error)) : null,
        ],
      );
      await this.lock.query(
        `UPDATE research_ingest_runs SET status=$2,stop_reason=$3,
        fatal_error=$4,stopped_at=now(),completed_at=now(),heartbeat_at=now() WHERE id=$1`,
        [
          this.runId,
          status,
          reason,
          error ? errorDetails(error).message : null,
        ],
      );
      await this.lock.query("COMMIT");
    } catch (failure) {
      await this.lock.query("ROLLBACK").catch(() => undefined);
      throw failure;
    } finally {
      // Destroying the connection releases all its session locks even after an error.
      this.lock.release(true);
    }
  }
}
