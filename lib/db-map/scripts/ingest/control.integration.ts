/** Global gate test: requires quiescence, preserves an operator's gate, uses one non-POI fixture. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getDb } from "../../lib/db/postgres.js";
import {
  changeMaintenance,
  controlState,
  requestStops,
  workerEvidence,
  reconcileAbsentExecution,
} from "../../sql/ingestion-control.js";
import { inspectControl, waitForStop } from "./control.js";
import { Execution, lockSource } from "./execution.js";
import { runOrchestration } from "./orchestrator.js";
import { REPO_ROOT } from "./source-file.js";

const db = getDb();
const actor = "control-integration-test";
const slug = "control_test_" + randomUUID().replaceAll("-", "");
let original: Awaited<ReturnType<typeof controlState>> | undefined;
let ownedToken: string | undefined;
let sourceId: string | undefined,
  ex: Execution | undefined,
  dir: string | undefined;
let restore = false;
try {
  const initial = await inspectControl(db);
  assert.equal(
    initial.quiescent,
    true,
    "Do not run control integration tests alongside workers",
  );
  original = initial.maintenance;
  if (original.maintenance) {
    assert.equal(
      process.argv[2],
      "--maintenance-token",
      "Pass the gate token to authorize temporary reopening for fixtures",
    );
    assert.equal(process.argv[3], original.maintenance_token);
    ownedToken = original.maintenance_token;
  } else {
    ownedToken = (
      await changeMaintenance(db, true, actor, "control integration test")
    ).maintenance_token;
  }
  restore = true;
  await assert.rejects(lockSource(db, slug), /maintenance is enabled/);
  await assert.rejects(
    changeMaintenance(db, false, actor, undefined, randomUUID()),
    /current maintenance token/,
  );
  await assert.rejects(
    changeMaintenance(db, true, actor, "must not replace owner"),
    /already enabled/,
  );
  await changeMaintenance(db, false, actor, undefined, ownedToken);
  ownedToken = undefined;
  dir = await mkdtemp(resolve(REPO_ROOT, "poi/control-test-"));
  const file = resolve(dir, slug + ".json");
  await writeFile(
    file,
    JSON.stringify([
      { source_record_id: "a", name: "Control test article", is_poi: false },
    ]),
  );
  await runOrchestration(db, {
    file,
    category: "campground",
    noLlm: true,
    dryRun: false,
    shadow: false,
    retryFailed: false,
    stopAfter: "normalize",
  });
  process.exitCode = 0;
  const run = (
    await db.query(
      "SELECT * FROM research_ingest_runs WHERE source_id=(SELECT id FROM research_sources WHERE slug=$1)",
      [slug],
    )
  ).rows[0];
  sourceId = run.source_id;
  // Admission is visible even before an execution exists.
  const admission = await lockSource(db, slug);
  assert.equal((await workerEvidence(db)).admitted.length, 1);
  assert.equal((await waitForStop(db, 0)).stopped, false);
  await assert.rejects(lockSource(db, slug), /Another managed ingestion/);
  ex = await Execution.start(db, run.id, { test: "control" }, admission);
  await requestStops(db, run.id, actor);
  assert.equal(
    (
      await db.query(
        "SELECT stop_requested FROM research_ingest_runs WHERE id=$1",
        [run.id],
      )
    ).rows[0].stop_requested,
    true,
  );
  // Prove the persistent global gate alone reaches the heartbeat, not just the pause flag.
  ownedToken = (await changeMaintenance(db, true, actor, "test graceful drain"))
    .maintenance_token;
  await db.query(
    "UPDATE research_ingest_runs SET stop_requested=false WHERE id=$1",
    [run.id],
  );
  await assert.rejects(
    lockSource(db, slug + "_other"),
    /maintenance is enabled/,
  );
  assert.equal(
    (await waitForStop(db, 0)).stopped,
    false,
    "A pause request is not a stop",
  );
  await ex.heartbeat();
  assert.equal(ex.stopped, true);
  await ex.finish("paused", "test_drain");
  const executionId = ex.id;
  ex = undefined;
  assert.equal((await waitForStop(db, 0)).stopped, true);
  assert.equal(
    (await waitForStop(db, 0, run.id)).stopped,
    false,
    "A terminal status does not prove that its PID exited",
  );
  // Simulated abandoned fixture preserves failures and only reconciles running attempts.
  await db.query(
    "UPDATE research_ingest_executions SET status='running',pid=2147483647 WHERE id=$1",
    [executionId],
  );
  await db.query(
    "UPDATE research_ingest_runs SET status='running' WHERE id=$1",
    [run.id],
  );
  await db.query(
    `INSERT INTO research_ingest_attempts(run_id,execution_id,stage,target_key,status,error)
    VALUES($1,$2,'normalize','failed-history','failed','{"message":"keep me"}'),($1,$2,'normalize','abandoned','running',NULL)`,
    [run.id, executionId],
  );
  await reconcileAbsentExecution(db, executionId, actor);
  const attempts = (
    await db.query(
      "SELECT target_key,status FROM research_ingest_attempts WHERE execution_id=$1 ORDER BY target_key",
      [executionId],
    )
  ).rows;
  assert.deepEqual(attempts, [
    { target_key: "abandoned", status: "interrupted" },
    { target_key: "failed-history", status: "failed" },
  ]);
  assert.equal(
    (
      await db.query("SELECT status FROM research_ingest_runs WHERE id=$1", [
        run.id,
      ])
    ).rows[0].status,
    "paused",
  );
  console.log(
    "PASS: maintenance admission, token ownership, source exclusion, startup visibility, pause/heartbeat, timeout, process-exit evidence, and retained recovery history",
  );
} finally {
  if (ex) await ex.finish("failed", "test_cleanup");
  sourceId ??= (
    await db.query("SELECT id FROM research_sources WHERE slug=$1", [slug])
  ).rows[0]?.id;
  if (sourceId) {
    await db.query("DELETE FROM research_pois WHERE source_id=$1", [sourceId]);
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
  if (restore) {
    if (original?.maintenance && !ownedToken)
      ownedToken = (
        await changeMaintenance(db, true, original.actor, original.reason)
      ).maintenance_token;
    if (!original?.maintenance && ownedToken)
      await changeMaintenance(db, false, actor, undefined, ownedToken);
    if (original?.maintenance)
      console.log(`Maintenance remains ON; exit token: ${ownedToken}`);
  }
  await db.end();
}
