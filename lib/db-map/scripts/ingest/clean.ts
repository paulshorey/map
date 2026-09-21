/**
 * Remove selected file records and every POI-scoped artifact derived from them.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:clean <poi/...json|jsonl|csv> --category <slug> [--limit N] [--dry-run]
 */
import type { Pool, PoolClient } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { recordsFor } from "./orchestrator.js";
import { rebuildCanonicalPoi } from "./merge.js";
import { resolveSourceFile } from "./source-file.js";
import type { RawRecord } from "./types.js";
import { verifyLineage } from "./verify.js";

interface CleanOptions {
  file: string;
  category?: string;
  limit?: number;
  dryRun: boolean;
}

interface CleanResult {
  state: "deleted" | "missing";
  runRecords: number;
  jobs: number;
  canonical: "deleted" | "rebuilt" | "none";
}

interface SelectedRecordGroup {
  sourceRecordId: string;
  records: RawRecord[];
}

function usageError(message: string): never {
  console.error(message);
  console.error(
    "Usage: ingest:clean <poi/...json|jsonl|csv> [--limit N] [--dry-run]",
  );
  process.exit(1);
}

function parseArgs(argv: string[]): CleanOptions {
  const file = argv[0];
  if (!file || file.startsWith("--")) usageError("Missing <file>.");

  const opts: CleanOptions = { file, dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === "--category") opts.category = value();
    else if (arg === "--limit") opts.limit = Number(value());
    else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (
    opts.limit !== undefined &&
    (!Number.isSafeInteger(opts.limit) || opts.limit < 0)
  ) {
    throw new Error(`Invalid --limit: ${opts.limit}`);
  }
  return opts;
}

function label(record: Pick<RawRecord, "source_record_id" | "name">): string {
  return `${record.source_record_id}${record.name ? ` \"${record.name.replace(/\"/g, "'")}\"` : ""}`;
}

function groupLabel(group: SelectedRecordGroup): string {
  const first = group.records[0]!;
  const coalesced =
    group.records.length > 1
      ? `; ${group.records.length} input records share this id`
      : "";
  return `${label(first)}${coalesced}`;
}

async function deletePipelineJobs(
  client: PoolClient,
  poiId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `WITH observations AS (
       SELECT id FROM research_poi_observations WHERE research_poi_id = $1
     ), normalizations AS (
       SELECT id FROM research_poi_normalizations WHERE research_poi_id = $1
     )
     DELETE FROM research_pipeline_jobs job
     WHERE (job.target_kind = 'research_poi' AND job.target_id = $1::uuid)
        OR (job.target_kind = 'observation' AND job.target_id IN (SELECT id FROM observations))
        OR (job.target_kind = 'normalization' AND job.target_id IN (SELECT id FROM normalizations))`,
    [poiId],
  );
  return rowCount ?? 0;
}

async function deleteRunRecords(
  client: PoolClient,
  poiId: string,
  sourceId: string,
  sourceRecordId: string,
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM research_ingest_run_records record
     USING research_source_file_versions version, research_source_files file
     WHERE record.source_file_version_id = version.id
       AND version.source_file_id = file.id
       AND (
         record.research_poi_id = $1::uuid
         OR (file.source_id = $2::uuid AND record.source_record_id = $3)
       )`,
    [poiId, sourceId, sourceRecordId],
  );
  return rowCount ?? 0;
}

async function cleanRecord(
  db: Pool,
  sourceId: string,
  sourceRecordId: string,
): Promise<CleanResult> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      canonical_poi_id: string | null;
      origin: "research" | "manual";
    }>(
      `SELECT rp.id, rp.canonical_poi_id, cp.origin
       FROM research_pois rp
       LEFT JOIN canonical_pois cp ON cp.id = rp.canonical_poi_id
       WHERE rp.source_id = $1 AND rp.source_record_id = $2
       FOR UPDATE OF rp`,
      [sourceId, sourceRecordId],
    );
    const poi = rows[0];
    if (!poi) {
      await client.query("COMMIT");
      return { state: "missing", runRecords: 0, jobs: 0, canonical: "none" };
    }

    if (poi.canonical_poi_id) {
      await client.query(
        `SELECT id FROM canonical_pois WHERE id = $1 FOR UPDATE`,
        [poi.canonical_poi_id],
      );
    }
    let jobs = await deletePipelineJobs(client, poi.id);
    const runRecords = await deleteRunRecords(
      client,
      poi.id,
      sourceId,
      sourceRecordId,
    );
    await client.query(`DELETE FROM research_pois WHERE id = $1`, [poi.id]);

    let canonical: CleanResult["canonical"] = "none";
    if (poi.canonical_poi_id) {
      const { rows: remainingRows } = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM research_canonical_memberships WHERE canonical_poi_id = $1 AND active`,
        [poi.canonical_poi_id],
      );
      if (
        Number(remainingRows[0]?.count ?? 0) === 0 &&
        poi.origin === "research"
      ) {
        // A canonical with no research rows is entirely derived from the item(s) just removed.
        // Its categories, occurrences, builds, redirects, and consolidation decisions cascade.
        const canonicalJobs = await client.query(
          `DELETE FROM research_pipeline_jobs
           WHERE target_kind = 'canonical_poi' AND target_id = $1`,
          [poi.canonical_poi_id],
        );
        jobs += canonicalJobs.rowCount ?? 0;
        await client.query(`DELETE FROM canonical_pois WHERE id = $1`, [
          poi.canonical_poi_id,
        ]);
        canonical = "deleted";
        // PostgreSQL cascade deletes the rest of the POI-scoped graph.
      } else if (Number(remainingRows[0]?.count ?? 0) > 0) {
        // Historical builds and consolidation verdicts can name the removed research row.
        // Rebuild the surviving canonical from its remaining source rows only.
        await client.query(
          `DELETE FROM canonical_poi_builds WHERE canonical_poi_id = $1`,
          [poi.canonical_poi_id],
        );
        await client.query(
          `DELETE FROM research_consolidation_decisions
           WHERE canonical_a = $1 OR canonical_b = $1`,
          [poi.canonical_poi_id],
        );
        const canonicalJobs = await client.query(
          `DELETE FROM research_pipeline_jobs
           WHERE target_kind = 'canonical_poi' AND target_id = $1`,
          [poi.canonical_poi_id],
        );
        jobs += canonicalJobs.rowCount ?? 0;
        await rebuildCanonicalPoi(client, poi.canonical_poi_id, {
          noLlm: true,
        });
        canonical = "rebuilt";
      } else {
        await client.query(
          `UPDATE canonical_pois SET status = 'hidden', updated_at = now() WHERE id = $1`,
          [poi.canonical_poi_id],
        );
      }
    }

    await client.query("COMMIT");
    return { state: "deleted", runRecords, jobs, canonical };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  // Do not pass --category through: clean is intentionally category-independent.
  // A source can have been imported under several categories over time.
  const resolved = await resolveSourceFile(opts.file);
  console.log(
    [
      "# ingest:clean",
      `file: ${resolved.logicalPath}`,
      `source: ${resolved.source.meta.slug}`,
      `registered category: ${resolved.file.category || "none"}`,
      opts.category
        ? `ignored category argument: ${opts.category}`
        : "category filter: none",
      `limit: ${opts.limit ?? "all"}`,
      opts.dryRun ? "dry-run: no database writes" : "mode: delete",
    ].join("\n"),
  );

  const selectedBySourceId = new Map<string, SelectedRecordGroup>();
  let seen = 0;
  let rejected = 0;
  for await (const record of recordsFor(resolved)) {
    if (opts.limit !== undefined && seen >= opts.limit) break;
    seen++;
    if (!record.source_record_id) {
      rejected++;
      console.log(
        `clean skipped (missing source_record_id)${record.name ? ` \"${record.name.replace(/\"/g, "'")}\"` : ""}`,
      );
      continue;
    }
    // research_pois is unique by (source_id, source_record_id). A bad extractor may
    // therefore have coalesced several raw input records into this one POI. Keep every
    // input item in the group, then purge that shared row and all of its lineage once.
    const group = selectedBySourceId.get(record.source_record_id);
    if (group) group.records.push(record);
    else
      selectedBySourceId.set(record.source_record_id, {
        sourceRecordId: record.source_record_id,
        records: [record],
      });
  }
  const selected = [...selectedBySourceId.values()];
  const duplicateInputs = selected.reduce(
    (count, group) => count + group.records.length - 1,
    0,
  );

  if (opts.dryRun) {
    for (const [index, group] of selected.entries()) {
      console.log(`clean would delete #${index + 1} ${groupLabel(group)}`);
    }
    console.log(
      `Clean: seen=${seen} inputRecords=${seen - rejected} uniqueSourceIds=${selected.length} ` +
        `duplicateInputs=${duplicateInputs} rejected=${rejected} (no writes)`,
    );
    return;
  }

  const db = getDb();
  try {
    const source = await db.query<{ id: string }>(
      `SELECT id FROM research_sources WHERE slug = $1`,
      [resolved.source.meta.slug],
    );
    const sourceId = source.rows[0]?.id;
    if (!sourceId) {
      console.log(
        `Clean: source ${resolved.source.meta.slug} has no database rows; nothing to delete.`,
      );
      return;
    }

    let deleted = 0;
    let missing = 0;
    let runRecords = 0;
    let jobs = 0;
    let canonicalsDeleted = 0;
    let canonicalsRebuilt = 0;
    for (const [index, group] of selected.entries()) {
      const result = await cleanRecord(db, sourceId, group.sourceRecordId);
      runRecords += result.runRecords;
      jobs += result.jobs;
      if (result.state === "missing") {
        missing++;
        console.log(`clean missing #${index + 1} ${groupLabel(group)}`);
        continue;
      }
      deleted++;
      if (result.canonical === "deleted") canonicalsDeleted++;
      if (result.canonical === "rebuilt") canonicalsRebuilt++;
      console.log(
        `clean deleted #${index + 1} ${groupLabel(group)} (canonical=${result.canonical})`,
      );
    }
    console.log(
      `Clean: seen=${seen} inputRecords=${seen - rejected} uniqueSourceIds=${selected.length} ` +
        `duplicateInputs=${duplicateInputs} deleted=${deleted} missing=${missing} rejected=${rejected} ` +
        `runRecords=${runRecords} jobs=${jobs} canonicalsDeleted=${canonicalsDeleted} canonicalsRebuilt=${canonicalsRebuilt}`,
    );
    if (await verifyLineage(db))
      throw new Error("Lineage verification failed after cleanup");
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("Ingest cleanup failed:", error);
  process.exit(1);
});
