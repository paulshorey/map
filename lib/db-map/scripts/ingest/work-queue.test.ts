/** Isolated fixture coverage for batched cache reuse. Never invokes paid providers. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { getDb } from "../../lib/db/postgres.js";
import { REPO_ROOT } from "./source-file.js";
import { runOrchestration } from "./orchestrator.js";
import { pendingStageItems, prepareStageQueue } from "./work-queue.js";
import { findReusableNormalizations } from "./normalize/runner.js";
import { getNormalizationProfile } from "./normalize/profiles.js";
import { Execution, lockSource } from "./execution.js";
const db = getDb();
const slug = "queue_test_" + randomUUID().replaceAll("-", "");
const dir = await mkdtemp(resolve(REPO_ROOT, "poi/queue-test-"));
const file = resolve(dir, slug + ".json");
const opts = {
  file,
  category: "campground",
  noLlm: true,
  dryRun: false,
  shadow: false,
  retryFailed: false,
};
let sourceId: string | undefined, ex: Execution | undefined;
try {
  await writeFile(
    file,
    JSON.stringify(
      ["a", "b", "c"].map((id) => ({
        source_record_id: id,
        name: "Queue fixture article " + id,
        is_poi: false,
      })),
    ),
  );
  await runOrchestration(db, { ...opts, stopAfter: "normalize" });
  process.exitCode = 0;
  sourceId = (
    await db.query("SELECT id FROM research_sources WHERE slug=$1", [slug])
  ).rows[0].id;
  const artifacts = async () =>
    (
      await db.query(
        `SELECT rp.id,rp.normalized_at,rp.active_normalization_id,n.activated_at FROM research_pois rp
    JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id WHERE rp.source_id=$1 ORDER BY rp.source_record_id`,
        [sourceId],
      )
    ).rows;
  const jobs = async () =>
    (
      await db.query(
        `SELECT j.* FROM research_pipeline_jobs j JOIN research_ingest_runs r ON r.id=j.run_id WHERE r.source_id=$1 ORDER BY j.id`,
        [sourceId],
      )
    ).rows;
  const before = await artifacts(),
    jobsBefore = await jobs();
  const normalize = {
    source: slug,
    noLlm: true,
    shadow: false,
    retryFailed: false,
    reprocess: false,
  };
  const ids = before.map((r) => r.id);
  assert.equal(
    (await findReusableNormalizations(db, normalize, ids)).length,
    3,
  );
  assert.equal(
    (await findReusableNormalizations(db, { ...normalize, noLlm: false }, ids))
      .length,
    0,
    "LLM mode is part of exact cache identity",
  );
  assert.equal(
    (
      await findReusableNormalizations(
        db,
        { ...normalize, reprocess: true, generation: randomUUID() },
        ids,
      )
    ).length,
    0,
    "explicit reprocessing must invalidate old cache",
  );
  assert.equal(
    (await findReusableNormalizations(db, { ...normalize, shadow: true }, ids))
      .length,
    0,
    "shadow validation stays on its normal path",
  );
  const profile = getNormalizationProfile("campground");
  const version = profile.version;
  try {
    profile.version += "-queue-test";
    assert.equal(
      (await findReusableNormalizations(db, normalize, ids)).length,
      0,
      "profile change invalidates cache",
    );
  } finally {
    profile.version = version;
  }
  // A fresh run reuses exact active artifacts in a batch, without reactivating or re-leasing jobs.
  await runOrchestration(db, { ...opts, stopAfter: "normalize" });
  process.exitCode = 0;
  const run = (
    await db.query(
      "SELECT * FROM research_ingest_runs WHERE source_id=$1 ORDER BY created_at DESC LIMIT 1",
      [sourceId],
    )
  ).rows[0];
  assert.equal(run.counters.queue.normalize.reused, 3);
  assert.equal(run.counters.queue.normalize.pending, 0);
  assert.deepEqual(
    await artifacts(),
    before,
    "cache reuse must not touch activation/projection timestamps",
  );
  assert.deepEqual(
    await jobs(),
    jobsBefore,
    "cache reuse must not rewrite pipeline jobs",
  );
  const latestAttempts = (
    await db.query(
      "SELECT output FROM research_ingest_attempts WHERE run_id=$1 AND stage='normalize'",
      [run.id],
    )
  ).rows;
  assert.equal(latestAttempts.length, 3);
  assert.ok(
    latestAttempts.every((a) => a.output.reuse_mode === "batch_active_cache"),
  );
  await runOrchestration(db, { ...opts, resume: run.id });
  assert.deepEqual(await artifacts(), before);
  const after = (
    await db.query("SELECT * FROM research_ingest_runs WHERE id=$1", [run.id])
  ).rows[0];
  assert.equal(after.status, "succeeded");
  assert.equal(after.counters.queue.normalize.checkpointed, 3);
  assert.equal((await pendingStageItems(db, run.id, "normalize")).length, 0);
  assert.equal((await pendingStageItems(db, run.id, "embed")).length, 0);
  // A failed middle item remains work even if higher ordinals have already completed.
  ex = await Execution.start(
    db,
    run.id,
    { test: "queue-hole" },
    await lockSource(db, slug),
  );
  await db.query(
    `INSERT INTO research_ingest_attempts(run_id,execution_id,stage,target_key,source_record_id,status,error,finished_at)
    VALUES($1,$2,'normalize','b','b','failed','{"message":"injected failure"}',now())`,
    [run.id, ex.id],
  );
  assert.deepEqual(
    (await pendingStageItems(db, run.id, "normalize")).map(
      (i) => i.source_record_id,
    ),
    ["b"],
  );
  const repaired = await prepareStageQueue(
    db,
    ex,
    "normalize",
    3,
    normalize,
    2,
  );
  assert.equal(repaired.checkpointed, 2);
  assert.equal(repaired.reused, 1);
  assert.equal(repaired.pending, 0);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM research_ingest_attempts WHERE run_id=$1 AND stage='normalize' AND status='failed'",
        [run.id],
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(await artifacts(), before);
  assert.deepEqual(await jobs(), jobsBefore);
  // A downstream result that is no longer applicable must re-enter the queue.
  await db.query(
    "UPDATE research_pois SET is_poi=true WHERE source_id=$1 AND source_record_id='b'",
    [sourceId],
  );
  assert.deepEqual(
    (await pendingStageItems(db, run.id, "embed")).map(
      (i) => i.source_record_id,
    ),
    ["b"],
  );
  await db.query(
    "UPDATE research_pois SET is_poi=false WHERE source_id=$1 AND source_record_id='b'",
    [sourceId],
  );
  await ex.finish("paused", "test_complete");
  ex = undefined;
  console.log(
    "PASS: exact cache fingerprints, batched new-run reuse, untouched artifacts/jobs, checkpoint-only resume, out-of-order failure holes, retained errors, and downstream invalidation.",
  );
} finally {
  if (ex) await ex.finish("failed", "test_cleanup");
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
    for (const table of [
      "research_pipeline_jobs",
      "research_ingest_attempts",
      "research_ingest_executions",
      "research_ingest_run_items",
    ])
      await db.query(`DELETE FROM ${table} WHERE run_id=ANY($1::uuid[])`, [
        runIds,
      ]);
    await db.query("DELETE FROM research_ingest_runs WHERE source_id=$1", [
      sourceId,
    ]);
    await db.query("DELETE FROM research_sources WHERE id=$1", [sourceId]);
  }
  await rm(dir, { recursive: true, force: true });
  await db.end();
  process.exitCode = 0;
}
