import { test } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { runRecordScheduler, recordFailure } from "./record-scheduler.js";
import { Execution } from "./execution.js";
import { RECORD_STAGES, type TaskClaim } from "../../sql/ingestion-tasks.js";
import { LlmError } from "./providers/llm.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function fixture(ids: string[]) {
  const tasks = ids.flatMap((id) =>
    RECORD_STAGES.map((stage, rank) => ({
      source_record_id: id,
      stage,
      rank,
      state: "pending",
    })),
  );
  const db = {
    query: async (sql: string, args: any[] = []) => {
      if (sql.startsWith("WITH selected")) {
        const stage = args[2],
          limit = args[4];
        const selected = tasks
          .filter(
            (t) =>
              t.stage === stage &&
              t.state === "pending" &&
              tasks
                .filter(
                  (p) =>
                    p.source_record_id === t.source_record_id &&
                    p.rank < t.rank,
                )
                .every((p) =>
                  ["succeeded", "reused", "skipped"].includes(p.state),
                ),
          )
          .slice(0, limit);
        for (const t of selected) t.state = "running";
        return {
          rows: selected.map((t) => ({
            ...t,
            run_id: "run",
            execution_id: "ex",
            claim_token: args[3],
            research_poi_id: t.source_record_id,
            observation_id: t.source_record_id,
          })),
        };
      }
      if (sql.startsWith("SELECT count")) return { rows: [{ n: 0 }] };
      if (sql.startsWith("SELECT stage,state"))
        return { rows: tasks.map((t) => ({ ...t, records: 1 })) };
      if (sql.startsWith("UPDATE research_ingest_tasks SET state=$6")) {
        const t = tasks.find(
          (t) => t.source_record_id === args[1] && t.stage === args[2],
        );
        if (t) t.state = args[5];
      }
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Pool;
  const ex = {
    id: "ex",
    stopped: false,
    stopReason: "",
    abortController: new AbortController(),
    check() {},
  } as unknown as Execution;
  const done = (claim: TaskClaim) => {
    tasks.find(
      (t) =>
        t.source_record_id === claim.source_record_id &&
        t.stage === claim.stage,
    )!.state = "succeeded";
  };
  return { db, ex, tasks, done };
}
test("ready records finish downstream while a slow normalization is still active", async () => {
  const f = fixture(["fast", "slow"]);
  const events: string[] = [];
  const result = await runRecordScheduler({
    ...f,
    run: "run",
    shadow: false,
    concurrency: 4,
    finiteBudget: false,
    execute: async (c) => {
      if (c.stage === "normalize")
        await sleep(c.source_record_id === "slow" ? 100 : 10);
      f.done(c);
      events.push(c.source_record_id + ":" + c.stage);
    },
  });
  assert.equal(result.partial, false);
  assert.ok(events.indexOf("fast:verify") < events.indexOf("slow:normalize"));
  assert.ok(f.tasks.every((t) => t.state === "succeeded"));
});
test("record validation quarantines only that record; independent records finish", async () => {
  const f = fixture(["bad", "good"]);
  const result = await runRecordScheduler({
    ...f,
    run: "run",
    shadow: false,
    concurrency: 4,
    finiteBudget: false,
    execute: async (c) => {
      if (c.source_record_id === "bad" && c.stage === "normalize")
        throw new Error("record_id mismatch");
      f.done(c);
    },
  });
  assert.equal(result.partial, true);
  assert.equal(
    f.tasks.find(
      (t) => t.source_record_id === "bad" && t.stage === "normalize",
    )!.state,
    "quarantined",
  );
  assert.equal(
    f.tasks.find((t) => t.source_record_id === "good" && t.stage === "verify")!
      .state,
    "succeeded",
  );
});
test("configuration/database failures stop globally and drain active work", async () => {
  const f = fixture(["auth", "slow"]);
  let finished = false;
  await assert.rejects(
    runRecordScheduler({
      ...f,
      run: "run",
      shadow: false,
      concurrency: 2,
      finiteBudget: false,
      execute: async (c) => {
        if (c.source_record_id === "auth")
          throw new LlmError("Unauthorized", false, 401);
        await sleep(20);
        f.done(c);
        finished = true;
      },
    }),
    /Unauthorized/,
  );
  assert.equal(f.ex.stopped, true);
  assert.equal(finished, true);
});
test("source-specific blocked data differs from transport and unexpected schema failures", () => {
  assert.equal(recordFailure(new LlmError("Rate limited", true, 429)), false);
  assert.equal(recordFailure(new Error("database unavailable")), false);
  assert.equal(recordFailure(new Error("record_id mismatch")), true);
});
test("repeated record failures trip a systemic circuit breaker before draining a file", async () => {
  const f = fixture(Array.from({ length: 30 }, (_, i) => `bad-${i}`));
  await assert.rejects(
    runRecordScheduler({
      ...f,
      run: "run",
      shadow: false,
      concurrency: 4,
      finiteBudget: false,
      execute: async () => {
        throw new Error("record_id mismatch");
      },
    }),
    /Ten consecutive/,
  );
  assert.equal(f.ex.stopReason, "systemic_record_failure");
  assert.ok(
    f.tasks.filter((t) => t.stage === "normalize" && t.state === "pending")
      .length > 0,
  );
});
