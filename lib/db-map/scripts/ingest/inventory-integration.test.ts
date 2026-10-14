/** Bounded live integration: two excluded fixture records, no providers; removes only its own data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { getDb } from "../../lib/db/postgres.js";
import { POI_ROOT, REPO_ROOT, hashSourceFile } from "./source-file.js";
import { runOrchestration } from "./orchestrator.js";
import {
  getInventory,
  editInventory,
  getInventoryDetail,
} from "../../sql/ingestion-inventory.js";
import { refreshInventory } from "../../lib/ingestion/inventory-scan.js";
import { traceResearchRecord } from "../../sql/lineage.js";
import {
  seedTasks,
  claimTasks,
  fenceTask,
  finishTask,
} from "../../sql/ingestion-tasks.js";
import type { Pool } from "pg";
const db = getDb();
const slug = "inventory_test_" + randomUUID().replaceAll("-", "");
const dir = await mkdtemp(resolve(POI_ROOT, "inventory-test-"));
const file = resolve(dir, slug + ".json");
const logical = relative(REPO_ROOT, file);
let inventoryId: string | undefined, sourceId: string | undefined;
const opts = {
  file,
  category: "campground",
  dryRun: false,
  noLlm: true,
  shadow: false,
  retryFailed: false,
};
try {
  await writeFile(
    file,
    JSON.stringify([
      { source_record_id: "a", name: "Inventory article A", is_poi: false },
      { source_record_id: "b", name: "Inventory article B", is_poi: false },
    ]),
  );
  const hash = await hashSourceFile(file);
  inventoryId = (
    await db.query(
      `INSERT INTO research_ingest_inventory(logical_path,format,file_sha256,byte_size,source_slug,category_slug,extractor_version,disposition)
    VALUES($1,'json',$2,$3,$4,'campground','generic-v1','import') RETURNING id`,
      [logical, hash.sha256, hash.byteSize, slug],
    )
  ).rows[0].id;
  const find = async () => {
    const f = (await getInventory(db, { file: logical })).files.find(
      (f) => f.id === inventoryId,
    );
    assert.ok(f);
    return f;
  };
  assert.equal((await find()).coverage, "unstarted");
  await runOrchestration(db, { ...opts, limit: 1 });
  sourceId = (
    await db.query("SELECT id FROM research_sources WHERE slug=$1", [slug])
  ).rows[0].id;
  const sample = await find();
  assert.equal(sample.coverage, "partial");
  assert.equal(sample.verified, 1);
  assert.equal(sample.total, null);
  await runOrchestration(db, { ...opts, stopAfter: "normalize" });
  const unfinishedFull = (await find()).latest_run!.id;
  await runOrchestration(db, { ...opts, limit: 1, stopAfter: "normalize" });
  const laterSmoke = await find();
  assert.equal(laterSmoke.latest_run!.options.limit, 1);
  assert.equal(laterSmoke.resume_run!.id, unfinishedFull);
  assert.match(laterSmoke.commands.resume!, new RegExp(unfinishedFull));
  await runOrchestration(db, opts);
  const full = await find();
  assert.equal(full.coverage, "complete");
  assert.equal(full.records, 2);
  assert.equal(full.verified, 2);
  assert.equal(full.excluded, 2);
  // Real PostgreSQL task SQL: lower-stage barriers, disjoint claims, fencing and atomic checkpoint rollback.
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const run = full.latest_run!.id;
    const execution = (
      await client.query(
        "SELECT id FROM research_ingest_executions WHERE run_id=$1 ORDER BY started_at DESC LIMIT 1",
        [run],
      )
    ).rows[0].id;
    await client.query(
      "UPDATE research_ingest_executions SET status='running' WHERE id=$1",
      [execution],
    );
    const scoped = client as unknown as Pool;
    await seedTasks(scoped, run, execution);
    await client.query(
      "UPDATE research_ingest_tasks SET state='pending' WHERE run_id=$1 AND stage='normalize'",
      [run],
    );
    assert.equal(
      (await claimTasks(scoped, run, execution, "match", 2)).length,
      0,
      "every prerequisite must complete",
    );
    const [one, two] = await Promise.all([
      claimTasks(scoped, run, execution, "normalize"),
      claimTasks(scoped, run, execution, "normalize"),
    ]);
    assert.equal(one.length, 1);
    assert.equal(two.length, 1);
    assert.notEqual(one[0]!.source_record_id, two[0]!.source_record_id);
    const claim = one[0]!;
    await assert.rejects(
      fenceTask(client, { ...claim, claim_token: randomUUID() }),
      /Stale task claim/,
    );
    await fenceTask(client, claim);
    const task = (
      await client.query(
        "SELECT attempt_id,output FROM research_ingest_tasks WHERE run_id=$1 AND source_record_id=$2 AND stage='normalize'",
        [run, claim.source_record_id],
      )
    ).rows[0];
    await client.query(
      "UPDATE research_ingest_attempts SET status='running' WHERE id=$1",
      [task.attempt_id],
    );
    await finishTask(client, claim, task.attempt_id, {
      ...task.output,
      status: "reused",
    });
    assert.equal(
      (
        await client.query(
          "SELECT state FROM research_ingest_tasks WHERE run_id=$1 AND source_record_id=$2 AND stage='normalize'",
          [run, claim.source_record_id],
        )
      ).rows[0].state,
      "reused",
    );
    assert.equal(
      (
        await client.query(
          "SELECT status FROM research_ingest_attempts WHERE id=$1",
          [task.attempt_id],
        )
      ).rows[0].status,
      "reused",
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
  const lockA = await db.connect(),
    lockB = await db.connect();
  try {
    await lockA.query("SELECT pg_advisory_lock_shared(91832,1)");
    assert.equal(
      (await lockB.query("SELECT pg_try_advisory_lock(91832,3) AS acquired"))
        .rows[0].acquired,
      true,
      "scan compatible with managed worker",
    );
    assert.equal(
      (await lockA.query("SELECT pg_try_advisory_lock(91832,3) AS acquired"))
        .rows[0].acquired,
      false,
      "second scanner serialized",
    );
    assert.equal(
      (await lockB.query("SELECT pg_try_advisory_lock(91832,1) AS acquired"))
        .rows[0].acquired,
      false,
      "maintenance still drains workers",
    );
  } finally {
    await lockA.query("SELECT pg_advisory_unlock_all()");
    await lockB.query("SELECT pg_advisory_unlock_all()");
    lockA.release();
    lockB.release();
  }
  const trace = (await traceResearchRecord(db, slug, "a")) as {
    research: { source_record_id: string };
    observations: unknown[];
    normalizations: unknown[];
    run_records: unknown[];
  };
  assert.equal(trace.research.source_record_id, "a");
  assert.ok(trace.observations.length > 0);
  assert.ok(trace.normalizations.length > 0);
  assert.ok(trace.run_records.length > 0);
  // A retry/resume cannot double-count the same source record.
  // Keep the historical run options intact while resolving the file through its
  // current source-file identity after a repository path migration.
  const legacyPath = logical.replace(/^data\//, "docs/");
  await db.query(
    "UPDATE research_ingest_runs SET options=jsonb_set(options,'{file}',to_jsonb($2::text)) WHERE id=$1",
    [full.latest_run!.id, legacyPath],
  );
  await runOrchestration(db, { ...opts, resume: full.latest_run!.id });
  assert.equal(
    (
      await db.query(
        "SELECT options->>'file' AS file FROM research_ingest_runs WHERE id=$1",
        [full.latest_run!.id],
      )
    ).rows[0].file,
    legacyPath,
  );
  assert.equal((await find()).records, 2);
  // Previously verified output becomes stale, so saved run success cannot certify it.
  await db.query(
    "UPDATE research_pois SET normalization_state='active_stale' WHERE source_id=$1 AND source_record_id='a'",
    [sourceId],
  );
  assert.equal((await find()).coverage, "partial");
  await db.query(
    "UPDATE research_pois SET normalization_state='rejected' WHERE source_id=$1 AND source_record_id='a'",
    [sourceId],
  );
  await editInventory(db, inventoryId!, {
    category_slug: "campground",
    disposition: "import",
    priority: 3,
    notes: "Resume here: retained fixture note",
    expected_updated_at: new Date((await find()).updated_at).toISOString(),
  });
  await assert.rejects(
    editInventory(db, inventoryId!, {
      category_slug: "campground",
      disposition: "ignored",
      priority: 0,
      notes: "",
    }),
    /reason/,
  );
  await assert.rejects(
    editInventory(db, inventoryId!, {
      category_slug: "invalid",
      disposition: "import",
      priority: 0,
      notes: "",
    }),
    /category/,
  );
  await assert.rejects(
    editInventory(db, inventoryId!, {
      category_slug: "campground",
      disposition: "import",
      priority: 0,
      notes: "stale edit",
      expected_updated_at: new Date(full.updated_at).toISOString(),
    }),
    /another session/,
  );
  await editInventory(db, inventoryId!, {
    category_slug: null,
    disposition: "needs_review",
    priority: 3,
    notes: "Resume here: retained fixture note",
    expected_updated_at: new Date((await find()).updated_at).toISOString(),
  });
  // The real scanner refreshes metadata only; operator decisions survive a changed file.
  await writeFile(file, "[]");
  await refreshInventory(db);
  const changed = await find();
  assert.equal(changed.coverage, "unstarted");
  assert.equal(changed.freshness, "changed");
  assert.equal(changed.notes, "Resume here: retained fixture note");
  assert.equal(changed.priority, 3);
  const detail = await getInventoryDetail(db, inventoryId!);
  assert.equal(detail.edits.length, 2);
  assert.equal(
    changed.category_slug,
    null,
    "scan must preserve an explicitly cleared category",
  );
  assert.ok(detail.runs.length >= 2);
  // Simulate disappearance as the scanner does, without deleting any source records.
  await rm(file);
  await refreshInventory(db);
  const missing = await find();
  assert.equal(missing.freshness, "missing");
  assert.equal(missing.commands.start, null);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM research_pois WHERE source_id=$1",
        [sourceId],
      )
    ).rows[0].n,
    2,
  );
  console.log(
    "PASS: inventory SQL, sample-vs-file completion, distinct retry counts, stale outputs, changed/missing files, edit validation, notes retained across scans, history preserved.",
  );
  process.exitCode = 0;
} finally {
  sourceId ??= (
    await db.query("SELECT id FROM research_sources WHERE slug=$1", [slug])
  ).rows[0]?.id;
  if (sourceId) {
    const ids = (
      await db.query("SELECT id FROM research_ingest_runs WHERE source_id=$1", [
        sourceId,
      ])
    ).rows.map((r) => r.id);
    await db.query(
      `DELETE FROM research_ingest_provider_call_items WHERE call_id IN (SELECT id FROM research_ingest_provider_calls WHERE run_id=ANY($1::uuid[]))`,
      [ids],
    );
    for (const table of [
      "research_ingest_tasks",
      "research_ingest_record_verifications",
      "research_ingest_provider_calls",
    ])
      await db.query(`DELETE FROM ${table} WHERE run_id=ANY($1::uuid[])`, [
        ids,
      ]);
    await db.query(
      `DELETE FROM research_ingest_issue_events WHERE issue_id IN (SELECT id FROM research_ingest_issues WHERE run_id=ANY($1::uuid[]))`,
      [ids],
    );
    await db.query(
      `DELETE FROM research_ingest_issues WHERE run_id=ANY($1::uuid[])`,
      [ids],
    );
    await db.query("DELETE FROM research_pois WHERE source_id=$1", [sourceId]);
    for (const table of [
      "research_pipeline_jobs",
      "research_ingest_attempts",
      "research_ingest_executions",
      "research_ingest_run_items",
    ])
      await db.query(`DELETE FROM ${table} WHERE run_id=ANY($1::uuid[])`, [
        ids,
      ]);
    await db.query("DELETE FROM research_ingest_runs WHERE source_id=$1", [
      sourceId,
    ]);
    await db.query("DELETE FROM research_sources WHERE id=$1", [sourceId]);
  }
  if (inventoryId)
    await db.query("DELETE FROM research_ingest_inventory WHERE id=$1", [
      inventoryId,
    ]);
  await rm(dir, { recursive: true, force: true });
  await db.end();
}
