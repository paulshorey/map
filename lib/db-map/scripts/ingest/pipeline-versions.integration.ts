/** Isolated, provider-free check of the GLM rollout's audited checkpoint compatibility. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDb } from "../../lib/db/postgres.js";
import { runOrchestration } from "./orchestrator.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import { POI_ROOT } from "./source-file.js";

const db = getDb();
const slug = `glm_resume_test_${randomUUID().replaceAll("-", "")}`;
const dir = await mkdtemp(resolve(POI_ROOT, "glm-resume-test-"));
const file = resolve(dir, `${slug}.json`);
try {
  await writeFile(
    file,
    JSON.stringify([
      { source_record_id: "a", name: "Resume test article", is_poi: false },
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
  assert.equal(finished.cohort, 1);
  assert.equal(finished.normalizations, 1);
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
  await rm(dir, { recursive: true, force: true });
  await db.end();
  process.exitCode = 0;
}
