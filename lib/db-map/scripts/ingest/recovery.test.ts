/** Integration tests use an isolated temporary source; never reset shared data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb } from "../../lib/db/postgres.js";
import { Execution, lockSource } from "./execution.js";
import { runOrchestration } from "./orchestrator.js";
import { inspectRun, parseStatusArgs } from "./status.js";

const db = getDb();
const slug = `recovery_test_${randomUUID().replaceAll("-", "")}`;
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const dir = await mkdtemp(resolve(root, "docs/poi/recovery-test-"));
const file = resolve(dir, `${slug}.json`);
let sourceId: string | undefined;
let open: Execution | undefined;
try {
  await writeFile(
    file,
    JSON.stringify([
      { source_record_id: "a", name: "Recovery test article A", is_poi: false },
      { source_record_id: "b", name: "Recovery test article B", is_poi: false },
    ]),
  );
  const opts = {
    file,
    category: "campground",
    dryRun: false,
    noLlm: true,
    shadow: false,
    retryFailed: false,
  };
  await runOrchestration(db, { ...opts, limit: 1, stopAfter: "normalize" });
  process.exitCode = 0;
  const {
    rows: [run],
  } = await db.query(
    `SELECT r.* FROM research_ingest_runs r
    JOIN research_sources s ON s.id=r.source_id WHERE s.slug=$1 ORDER BY r.created_at DESC LIMIT 1`,
    [slug],
  );
  assert.ok(run);
  sourceId = run.source_id;
  const initial = await inspectRun(db, parseStatusArgs(["--run", run.id]));
  assert.equal(initial.run.status, "paused");
  assert.equal(initial.scopeRecords, 1);
  assert.equal(
    initial.attempts.find((a) => a.stage === "normalize")?.targets,
    1,
  );
  // Derived fields must not leak into immutable normalization input/cache keys.
  await db.query(
    "UPDATE research_pois SET description='derived projection, not source evidence' WHERE source_id=$1",
    [sourceId],
  );
  // A newer run must not hide a later execution of an older run from "latest".
  await runOrchestration(db, { ...opts, limit: 1, stopAfter: "normalize" });
  process.exitCode = 0;
  assert.notEqual(
    (await inspectRun(db, parseStatusArgs(["--source", slug]))).run.id,
    run.id,
  );
  const cacheCheck = await db.query(
    `SELECT output FROM research_ingest_attempts a JOIN research_ingest_runs r ON r.id=a.run_id WHERE r.source_id=$1 AND stage='normalize' ORDER BY a.started_at DESC LIMIT 1`,
    [sourceId],
  );
  assert.equal(
    cacheCheck.rows[0].output.cacheHits,
    1,
    "normalization caches must depend only on captured evidence",
  );
  // A pinned resume finishes only the original item; no implicit full-source drain.
  await runOrchestration(db, { ...opts, resume: run.id });
  const finished = await inspectRun(db, parseStatusArgs(["--run", run.id]));
  assert.equal(finished.run.status, "succeeded");
  assert.equal(
    (await inspectRun(db, parseStatusArgs(["--source", slug]))).run.id,
    run.id,
  );
  assert.ok(finished.run.verified_at);
  assert.equal(finished.scopeRecords, 1);
  assert.equal(
    (
      await db.query(
        `SELECT count(*)::int AS n FROM research_ingest_attempts WHERE run_id=$1 AND stage='normalize'`,
        [run.id],
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM research_pois WHERE source_id=$1",
        [sourceId],
      )
    ).rows[0].n,
    1,
  );

  // Previously completed ledger entries cannot certify missing current outputs.
  await db.query(
    "UPDATE research_pois SET normalization_state='pending' WHERE source_id=$1",
    [sourceId],
  );
  await assert.rejects(
    runOrchestration(db, { ...opts, resume: run.id }),
    /Scope verification/,
  );
  process.exitCode = 0;
  const damaged = await inspectRun(db, parseStatusArgs(["--run", run.id]));
  assert.equal(damaged.run.status, "failed");
  assert.equal(damaged.run.verified_at, null);
  await db.query(
    "UPDATE research_pois SET normalization_state='rejected' WHERE source_id=$1",
    [sourceId],
  );
  await runOrchestration(db, { ...opts, resume: run.id });

  // Start a worker and kill it only after its durable attempt exists.
  const executionPath = fileURLToPath(
    new URL("./execution.ts", import.meta.url),
  );
  const postgresPath = fileURLToPath(
    new URL("../../lib/db/postgres.ts", import.meta.url),
  );
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import {Execution,lockSource} from ${JSON.stringify(executionPath)};
    import {getDb} from ${JSON.stringify(postgresPath)};
    const db=getDb();const lock=await lockSource(db,${JSON.stringify(slug)});
    const ex=await Execution.start(db,${JSON.stringify(run.id)},{test:'kill'},lock);
    await ex.attempt('embed','kill-fixture',{},async()=>{
      console.log('DURABLE_ATTEMPT'); await new Promise(r=>setTimeout(r,60000));return {status:'succeeded'};
    });await ex.finish('succeeded','test');await db.end();
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Worker setup timed out: ${stderr}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("DURABLE_ATTEMPT")) {
        clearTimeout(timeout);
        resolveReady();
      }
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timeout);
      reject(new Error(`Worker exited before test: ${stderr}`));
    });
  });
  // The source lock fences concurrent workers, even while the first awaits a provider.
  await assert.rejects(lockSource(db, slug), /Another managed ingestion/);
  await new Promise((resolve) => setTimeout(resolve, 5500));
  const heartbeat = (
    await db.query(
      `SELECT heartbeat_at>started_at AS advanced FROM research_ingest_executions
    WHERE run_id=$1 ORDER BY started_at DESC LIMIT 1`,
      [run.id],
    )
  ).rows[0];
  assert.equal(
    heartbeat.advanced,
    true,
    "heartbeat must advance while work is awaiting a provider",
  );
  child.kill("SIGKILL");
  await exited;
  open = await Execution.start(
    db,
    run.id,
    { test: "recovery" },
    await lockSource(db, slug),
  );
  const interrupted = (
    await db.query(
      `SELECT status,error FROM research_ingest_attempts
    WHERE run_id=$1 AND target_key='kill-fixture'`,
      [run.id],
    )
  ).rows[0];
  assert.equal(interrupted.status, "interrupted");
  assert.match(interrupted.error.message, /unknown/);
  await open.attempt("embed", "kill-fixture", {}, async () => ({
    status: "succeeded",
    marker: "recovered",
  }));
  let repeated = false;
  await open.attempt("embed", "kill-fixture", {}, async () => {
    repeated = true;
    return { status: "succeeded" };
  });
  assert.equal(repeated, false, "completed work must be skipped");
  let artifactPresent = true;
  let repairs = 0;
  const repair = async () => {
    repairs++;
    artifactPresent = true;
    return { status: "succeeded" as const };
  };
  await open.attempt(
    "embed",
    "artifact-fixture",
    {},
    repair,
    true,
    async () => artifactPresent,
  );
  artifactPresent = false;
  await open.attempt(
    "embed",
    "artifact-fixture",
    {},
    repair,
    true,
    async () => artifactPresent,
  );
  await open.attempt(
    "embed",
    "artifact-fixture",
    {},
    repair,
    true,
    async () => artifactPresent,
  );
  assert.equal(repairs, 2, "missing output must be repaired, then reused");
  await assert.rejects(
    open.attempt("geocode", "error-fixture", {}, async () => {
      throw new Error("injected provider failure");
    }),
    /injected/,
  );
  await open.attempt("geocode", "error-fixture", {}, async () => ({
    status: "succeeded",
  }));
  const history = (
    await db.query(
      `SELECT status,error FROM research_ingest_attempts WHERE run_id=$1 AND target_key='error-fixture' ORDER BY started_at`,
      [run.id],
    )
  ).rows;
  assert.deepEqual(
    history.map((a) => a.status),
    ["failed", "succeeded"],
  );
  assert.match(history[0].error.stack, /injected provider failure/);
  await db.query(
    "UPDATE research_ingest_runs SET stop_requested=true WHERE id=$1",
    [run.id],
  );
  await open.heartbeat();
  assert.ok(open.stopped);
  assert.equal(open.stopReason, "pause_requested");
  await open.finish("paused", "pause_requested");
  open = undefined;
  // Exercise actual SIGTERM delivery: finish the current unit and persist the reason.
  const graceful = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import {Execution,lockSource} from ${JSON.stringify(executionPath)};
    import {getDb} from ${JSON.stringify(postgresPath)};
    const db=getDb();const ex=await Execution.start(db,${JSON.stringify(run.id)},{test:'term'},await lockSource(db,${JSON.stringify(slug)}));
    await ex.attempt('embed','term-fixture',{},async()=>{
      console.log('READY');await new Promise(r=>setTimeout(r,500));return {status:'succeeded'};
    });await ex.finish(ex.stopped?'paused':'succeeded',ex.stopReason||'done');await db.end();
  `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const gracefulExit = new Promise<number | null>((resolveExit, reject) => {
    graceful.once("exit", resolveExit);
    graceful.once("error", reject);
  });
  graceful.stdout.on("data", (chunk) => {
    if (String(chunk).includes("READY")) graceful.kill("SIGTERM");
  });
  const gracefulTimeout = setTimeout(() => graceful.kill("SIGKILL"), 15000);
  assert.equal(await gracefulExit, 0);
  clearTimeout(gracefulTimeout);
  const terminated = (
    await db.query(
      "SELECT status,stop_reason FROM research_ingest_runs WHERE id=$1",
      [run.id],
    )
  ).rows[0];
  assert.equal(terminated.status, "paused");
  assert.equal(terminated.stop_reason, "SIGTERM");
  // Source bytes changed: refuse a misleading resume of different input.
  await writeFile(file, "[]");
  await assert.rejects(
    runOrchestration(db, { ...opts, resume: run.id }),
    /Source file changed/,
  );
  console.log(
    "PASS: fixed scope, resume skips completed work, real SIGKILL recovery, periodic heartbeat, graceful SIGTERM, source lock exclusion, retained failure history, remote pause, changed-file guard, missing-output recovery, and verification-before-success.",
  );
} finally {
  if (open) await open.finish("failed", "test_cleanup");
  sourceId ??= (
    await db.query("SELECT id FROM research_sources WHERE slug=$1", [slug])
  ).rows[0]?.id;
  if (sourceId) {
    await db.query("DELETE FROM research_pois WHERE source_id=$1", [sourceId]);
    const runIds = (
      await db.query("SELECT id FROM research_ingest_runs WHERE source_id=$1", [
        sourceId,
      ])
    ).rows.map((r) => r.id);
    await db.query(
      "DELETE FROM research_pipeline_jobs WHERE run_id=ANY($1::uuid[])",
      [runIds],
    );
    await db.query(
      "DELETE FROM research_ingest_attempts WHERE run_id=ANY($1::uuid[])",
      [runIds],
    );
    await db.query(
      "DELETE FROM research_ingest_executions WHERE run_id=ANY($1::uuid[])",
      [runIds],
    );
    await db.query(
      "DELETE FROM research_ingest_run_items WHERE run_id=ANY($1::uuid[])",
      [runIds],
    );
    await db.query("DELETE FROM research_ingest_runs WHERE source_id=$1", [
      sourceId,
    ]);
    await db.query("DELETE FROM research_sources WHERE id=$1", [sourceId]);
  }
  await rm(dir, { recursive: true, force: true });
  await db.end();
  process.exitCode = 0;
}
