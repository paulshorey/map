/** Isolated, provider-free check of the GLM rollout's audited checkpoint compatibility. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { getDb } from "../../lib/db/postgres.js";
import { runOrchestration } from "./orchestrator.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import { POI_ROOT, REPO_ROOT, hashSourceFile } from "./source-file.js";
import { getInventory } from "../../sql/ingestion-inventory.js";
import { queueItem } from "../../lib/ingestion/queue.js";

const db = getDb();
const slug = `glm_resume_test_${randomUUID().replaceAll("-", "")}`;
const dir = await mkdtemp(resolve(POI_ROOT, "glm-resume-test-"));
const file = resolve(dir, `${slug}.json`);
let inventoryId: string | undefined;
try {
  await writeFile(
    file,
    JSON.stringify([
      { source_record_id: "a", name: "Resume test article", is_poi: false },
      {
        source_record_id: "b",
        name: "Excluded resume test article",
        is_poi: false,
      },
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
  const hash = await hashSourceFile(file);
  inventoryId = (
    await db.query(
      `INSERT INTO research_ingest_inventory(logical_path,format,file_sha256,byte_size,source_slug,category_slug,extractor_version,disposition)
    VALUES($1,'json',$2,$3,$4,'campground','generic-v1','import') RETURNING id`,
      [relative(REPO_ROOT, file), hash.sha256, hash.byteSize, slug],
    )
  ).rows[0].id;
  const inventory = async () =>
    (await getInventory(db, { file: relative(REPO_ROOT, file) })).files[0]!;
  await runOrchestration(db, { ...opts, stopAfter: "normalize" });
  process.exitCode = 0;
  const run = (
    await db.query(
      "SELECT r.* FROM research_ingest_runs r JOIN research_sources s ON s.id=r.source_id WHERE s.slug=$1",
      [slug],
    )
  ).rows[0];
  const before = (
    await db.query(
      "SELECT id,active_observation_id,active_normalization_id FROM research_pois WHERE source_id=$1",
      [run.source_id],
    )
  ).rows;
  const legacy = {
    ...PIPELINE_VERSIONS,
    normalizer: "hybrid-v3",
    prompt: "poi-normalize-v2",
  };
  await db.query(
    "UPDATE research_ingest_runs SET pipeline_versions=$2::jsonb WHERE id=$1",
    [run.id, JSON.stringify({ ...legacy, schema: "incompatible" })],
  );
  await assert.rejects(
    runOrchestration(db, { ...opts, resume: run.id }),
    /Pipeline versions changed/,
  );
  await db.query(
    "UPDATE research_ingest_runs SET pipeline_versions=$2::jsonb WHERE id=$1",
    [run.id, JSON.stringify(legacy)],
  );
  assert.equal(
    (await inventory()).resume_run?.id,
    run.id,
    "compatible old full run must remain resumable in the dashboard",
  );
  // A deliberate exclusion under the original version remains authoritative after
  // audited full verification of the same frozen observations. Only this fixture is touched.
  const excluded = (
    await db.query(
      "SELECT * FROM research_ingest_run_items WHERE run_id=$1 AND source_record_id='b'",
      [run.id],
    )
  ).rows[0];
  const priorExecution = (
    await db.query(
      "SELECT id FROM research_ingest_executions WHERE run_id=$1 ORDER BY started_at DESC LIMIT 1",
      [run.id],
    )
  ).rows[0].id;
  await db.query("UPDATE research_pois SET retired_at=now() WHERE id=$1", [
    excluded.research_poi_id,
  ]);
  await db.query(
    "INSERT INTO research_ingest_issues(run_id,source_record_id,stage,code,scope,severity,message,status) VALUES($1,'b','normalize','fixture_exclusion','record','blocking','Scoped test exclusion','excluded')",
    [run.id],
  );
  await db.query(
    "UPDATE research_ingest_tasks SET state='skipped' WHERE run_id=$1 AND source_record_id='b'",
    [run.id],
  );
  await db.query(
    "INSERT INTO research_ingest_record_verifications(run_id,source_record_id,execution_id,observation_id,output,pipeline_versions,outcome) VALUES($1,'b',$2,$3,'{}',$4,'operator_excluded')",
    [run.id, priorExecution, excluded.observation_id, JSON.stringify(legacy)],
  );
  await runOrchestration(db, { ...opts, resume: run.id });
  const after = (
    await db.query(
      "SELECT id,active_observation_id,active_normalization_id FROM research_pois WHERE source_id=$1",
      [run.source_id],
    )
  ).rows;
  assert.deepEqual(
    after,
    before,
    "completed observations/normalizations must remain unchanged",
  );
  const finished = (
    await db.query(
      "SELECT status,verified_at,pipeline_versions,(SELECT count(*)::int FROM research_ingest_run_items WHERE run_id=r.id) AS cohort,(SELECT count(*)::int FROM research_ingest_attempts WHERE run_id=r.id AND stage='normalize') AS normalizations FROM research_ingest_runs r WHERE id=$1",
      [run.id],
    )
  ).rows[0];
  assert.equal(finished.status, "succeeded");
  assert.ok(finished.verified_at);
  assert.equal(finished.cohort, 2);
  assert.equal(finished.normalizations, 2);
  assert.deepEqual(finished.pipeline_versions, legacy);
  const options = (
    await db.query(
      "SELECT options FROM research_ingest_executions WHERE run_id=$1 ORDER BY started_at DESC LIMIT 1",
      [run.id],
    )
  ).rows[0].options;
  assert.deepEqual(options.pipeline_version_upgrade, {
    from: legacy,
    to: PIPELINE_VERSIONS,
  });
  const complete = await inventory();
  assert.equal(
    complete.coverage,
    "complete",
    "audited current verification must recognize the upgraded full run",
  );
  assert.equal(complete.verified, 2);
  assert.equal(
    complete.excluded,
    2,
    "old explicit exclusion is retained alongside the non-POI record",
  );
  assert.equal(queueItem(complete).action, "complete");
  await writeFile(file, "[]");
  await assert.rejects(
    runOrchestration(db, { ...opts, resume: run.id }),
    /Source file changed/,
  );
  console.log(
    "PASS: audited GLM upgrade, unchanged completed artifacts/cohort, no repeat normalization, incompatible-version and changed-source guards.",
  );
} finally {
  const source = (
    await db.query("SELECT id FROM research_sources WHERE slug=$1", [slug])
  ).rows[0];
  if (source) {
    const ids = (
      await db.query("SELECT id FROM research_ingest_runs WHERE source_id=$1", [
        source.id,
      ])
    ).rows.map((row) => row.id);
    await db.query(
      "DELETE FROM research_ingest_record_verifications WHERE run_id=ANY($1::uuid[])",
      [ids],
    );
    await db.query(
      "DELETE FROM research_ingest_issues WHERE run_id=ANY($1::uuid[])",
      [ids],
    );
    await db.query("DELETE FROM research_pois WHERE source_id=$1", [source.id]);
    for (const table of [
      "research_ingest_tasks",
      "research_pipeline_jobs",
      "research_ingest_attempts",
      "research_ingest_executions",
      "research_ingest_run_items",
    ])
      await db.query(`DELETE FROM ${table} WHERE run_id=ANY($1::uuid[])`, [
        ids,
      ]);
    await db.query("DELETE FROM research_ingest_runs WHERE source_id=$1", [
      source.id,
    ]);
    await db.query("DELETE FROM research_sources WHERE id=$1", [source.id]);
  }
  if (inventoryId)
    await db.query("DELETE FROM research_ingest_inventory WHERE id=$1", [
      inventoryId,
    ]);
  await rm(dir, { recursive: true, force: true });
  await db.end();
  process.exitCode = 0;
}
