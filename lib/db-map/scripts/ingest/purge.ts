/**
 * Delete every imported record, run and canonical POI so all sources can be re-ingested from
 * their raw captures under the current pipeline (the policy for outdated data; see
 * `ingest:staleness`). For one file, prefer `ingest:clean <file>`.
 *
 * Kept: the paid geocode query cache (`research_geocode_cache`), the category taxonomy, users
 * and preferences, the ingestion control gate and its events, the capture inventory, centroid
 * references and the migration cursor. Local job journals are not touched.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:purge --dry-run
 *   pnpm --filter @lib/db-map ingest:purge --maintenance-token <owned-token> --confirm purge-all-imports
 */
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";

/** Truncated together, so their foreign keys need no ordering. */
export const PURGED_TABLES = [
  "canonical_pois",
  "canonical_poi_builds",
  "canonical_poi_build_inputs",
  "canonical_poi_categories",
  "canonical_poi_occurrences",
  "canonical_poi_redirects",
  "canonical_poi_locations",
  "research_consolidation_decisions",
  "research_canonical_memberships",
  "research_match_decisions",
  "research_match_overrides",
  "research_pois",
  "research_poi_observations",
  "research_poi_normalizations",
  "research_poi_normalization_occurrences",
  "research_normalization_requests",
  "research_poi_embeddings",
  "research_poi_geocodes",
  "research_poi_location_assessments",
  "research_poi_locations",
  "research_ingest_runs",
  "research_ingest_executions",
  "research_ingest_attempts",
  "research_ingest_tasks",
  "research_ingest_run_items",
  "research_ingest_run_records",
  "research_ingest_record_verifications",
  "research_ingest_provider_calls",
  "research_ingest_provider_call_items",
  "research_ingest_issues",
  "research_ingest_issue_events",
  "research_ingest_quality_reviews",
  "research_pipeline_jobs",
  "research_source_files",
  "research_source_file_versions",
] as const;

const CONFIRMATION = "purge-all-imports";

export async function purgeCounts(db: Pool): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of PURGED_TABLES)
    counts[table] = Number(
      (await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n,
    );
  return counts;
}

/** Requires owned, quiescent maintenance (no worker can hold admission while this runs). */
export async function purgeAllImports(db: Pool, maintenanceToken: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const gate = (
      await client.query(
        "SELECT * FROM research_ingest_control WHERE singleton FOR UPDATE",
      )
    ).rows[0];
    const drain = (
      await client.query("SELECT pg_try_advisory_xact_lock(91832,1) AS acquired")
    ).rows[0];
    if (!gate?.maintenance || !drain.acquired || gate.maintenance_token !== maintenanceToken)
      throw new Error("Owned, quiescent maintenance is required to purge imports");
    await client.query(`TRUNCATE ${PURGED_TABLES.join(", ")}`);
    await client.query(
      `INSERT INTO research_ingest_control_events(action, actor, details)
       VALUES ('purge_all_imports', current_user, $1::jsonb)`,
      [
        JSON.stringify({
          reason: "Outdated data is re-ingested, not upgraded in place",
          tables: PURGED_TABLES,
        }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const db = getDb();
  try {
    const before = await purgeCounts(db);
    const total = Object.values(before).reduce((a, b) => a + b, 0);
    if (args.includes("--dry-run")) {
      console.table(before);
      console.log(`Dry run: ${total} rows in ${PURGED_TABLES.length} tables would be deleted.`);
      return;
    }
    const token = value("--maintenance-token");
    if (!token || value("--confirm") !== CONFIRMATION)
      throw new Error(
        `Refusing: pass --maintenance-token <owned-token> --confirm ${CONFIRMATION} (try --dry-run first)`,
      );
    await purgeAllImports(db, token);
    const after = await purgeCounts(db);
    console.log(
      `Purged ${total} rows; remaining: ${Object.values(after).reduce((a, b) => a + b, 0)}. ` +
        "The geocode cache, taxonomy, users, controls and capture inventory were kept.",
    );
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
