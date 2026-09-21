/** Explicit opt-in, one non-POI record, no providers/models/notifications. Cheap runner executes. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { resolve } from "node:path";
import { getDb, closeDb } from "../../lib/db/postgres.js";
import { inspectControl } from "./control.js";
import { REPO_ROOT } from "./source-file.js";
import { jobPath, loadJob } from "./supervisor-state.js";
const db = getDb(),
  jobs: string[] = [];
const slug = "supervisor_test_" + randomUUID().replaceAll("-", "");
let dir: string | undefined, sourceId: string | undefined;
async function cli(args: string[]) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/ingest/supervise.ts", ...args],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
  });
  child.stderr.on("data", (b) => {
    stderr += b;
  });
  const code = await new Promise<number | null>((res, rej) => {
    child.once("error", rej);
    child.once("exit", res);
  });
  assert.ok(stdout.trim(), stderr);
  return { code, data: JSON.parse(stdout) };
}
async function result(id: string) {
  return new Promise<any>((resolveResult, reject) => {
    const timer = setTimeout(
      () => finish(new Error("Fixture did not finish within 60 seconds")),
      60_000,
    );
    const watcher = watch(jobPath(id, ""), () => void check());
    function finish(error?: Error, value?: any) {
      clearTimeout(timer);
      watcher.close();
      error ? reject(error) : resolveResult(value);
    }
    async function check() {
      try {
        finish(
          undefined,
          JSON.parse(await readFile(jobPath(id, "result.json"), "utf8")),
        );
      } catch {}
    }
    void check();
  });
}
try {
  const initial = await inspectControl(db);
  assert.equal(initial.quiescent, true);
  assert.equal(initial.maintenance.maintenance, false);
  dir = await mkdtemp(resolve(REPO_ROOT, "poi/supervisor-test-"));
  const file = resolve(dir, slug + ".json");
  await writeFile(
    file,
    JSON.stringify([
      { source_record_id: "a", name: "Supervisor test article", is_poi: false },
    ]),
  );
  const smoke = await cli([
    "smoke",
    "--timeout-seconds",
    "45",
    "--",
    file,
    "--category",
    "campground",
    "--limit",
    "1",
    "--no-llm",
    "--max-llm-requests",
    "0",
    "--max-cost-usd",
    "0",
    "--stop-after",
    "normalize",
  ]);
  const first = smoke.data;
  jobs.push(first.job_id);
  assert.ok(first.run_id);
  assert.ok(first.execution_id);
  assert.equal(first.probe_error, undefined);
  assert.equal(first.evidence.scope_records, 1);
  assert.equal(first.evidence.stop_reason, "stop_after_normalize");
  assert.equal(first.health_checks, 0);
  // Local-only is intentional test isolation: never invoke a paid reporter or parent callback.
  const launch = await cli([
    "start",
    "--local-only",
    "--max-hours",
    "1",
    "--",
    "--resume",
    first.run_id,
    "--stop-after",
    "report",
    "--max-llm-requests",
    "0",
    "--max-cost-usd",
    "0",
  ]);
  assert.equal(launch.code, 0);
  jobs.push(launch.data.job_id);
  assert.equal(launch.data.notification, "local_only");
  const second = await result(launch.data.job_id);
  assert.equal(second.run_id, first.run_id);
  assert.notEqual(second.execution_id, first.execution_id);
  assert.equal(second.probe_error, undefined);
  assert.equal(second.evidence.scope_records, 1);
  assert.equal(second.health_checks, 0);
  assert.ok(
    ["paused", "succeeded", "partial"].includes(second.evidence.status),
    JSON.stringify(second),
  );
  assert.equal((await loadJob(first.job_id)).status, "finished");
  console.log(
    "PASS: one-record smoke, IPC run/execution identity, detached bounded-cohort resume, durable terminal evidence; no providers/models/callbacks",
  );
} finally {
  const state = await inspectControl(db);
  if (!state.quiescent) {
    for (const id of jobs)
      await writeFile(jobPath(id, "stop.request"), "integration cleanup");
    console.error(
      "Fixture cleanup deferred: workers still present; inspect recorded jobs before deleting data",
    );
    process.exitCode = 1;
  } else {
    sourceId = (
      await db.query("SELECT id FROM research_sources WHERE slug=$1", [slug])
    ).rows[0]?.id;
    if (sourceId) {
      await db.query("DELETE FROM research_pois WHERE source_id=$1", [
        sourceId,
      ]);
      for (const table of [
        "research_pipeline_jobs",
        "research_ingest_attempts",
        "research_ingest_executions",
        "research_ingest_run_items",
      ])
        await db.query(
          `DELETE FROM ${table} WHERE run_id IN (SELECT id FROM research_ingest_runs WHERE source_id=$1)`,
          [sourceId],
        );
      await db.query("DELETE FROM research_ingest_runs WHERE source_id=$1", [
        sourceId,
      ]);
      await db.query("DELETE FROM research_sources WHERE id=$1", [sourceId]);
    }
    if (dir) await rm(dir, { recursive: true, force: true });
    for (const id of jobs)
      await rm(jobPath(id, ""), { recursive: true, force: true });
  }
  await closeDb();
}
