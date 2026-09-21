/** Bounded live integration: two excluded fixture records, no providers; removes only its own data. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { getDb } from "../../lib/db/postgres.js";
import { REPO_ROOT, hashSourceFile } from "./source-file.js";
import { runOrchestration } from "./orchestrator.js";
import {
  getInventory,
  editInventory,
  getInventoryDetail,
} from "../../sql/ingestion-inventory.js";
import { refreshInventory } from "../../lib/ingestion/inventory-scan.js";
const db = getDb();
const slug = "inventory_test_" + randomUUID().replaceAll("-", "");
const dir = await mkdtemp(resolve(REPO_ROOT, "poi/inventory-test-"));
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
    const f = (await getInventory(db)).files.find((f) => f.id === inventoryId);
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
  await runOrchestration(db, opts);
  const full = await find();
  assert.equal(full.coverage, "complete");
  assert.equal(full.records, 2);
  assert.equal(full.verified, 2);
  assert.equal(full.excluded, 2);
  // A retry/resume cannot double-count the same source record.
  await runOrchestration(db, { ...opts, resume: full.latest_run!.id });
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
} finally {
  sourceId ??= (
    await db.query("SELECT id FROM research_sources WHERE slug=$1", [slug])
  ).rows[0]?.id;
  if (sourceId) {
    await db.query("DELETE FROM research_pois WHERE source_id=$1", [sourceId]);
    const ids = (
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
  process.exitCode = 0;
}
