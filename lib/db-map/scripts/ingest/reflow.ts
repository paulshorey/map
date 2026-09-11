/**
 * Reset derived ingestion columns so existing research rows flow through the updated
 * normalize/embed/match logic without requiring source content changes.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:reflow [--source <slug>] [--category <slug>] [--dry-run]
 */
import { getDb } from "../../lib/db/postgres.js";

interface CliOptions {
  source?: string;
  category?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let category: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--category" && argv[i + 1]) category = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  return { source, category, dryRun };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const params: unknown[] = [];
  const where: string[] = ["is_poi"];
  if (opts.source) {
    params.push(opts.source);
    where.push(`source_id = (SELECT id FROM research_sources WHERE slug = $${params.length})`);
  }
  if (opts.category) {
    params.push(opts.category);
    where.push(`ingest_category = $${params.length}`);
  }

  const whereSql = where.join(" AND ");
  if (opts.dryRun) {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM research_pois WHERE ${whereSql}`,
      params,
    );
    console.log(`Reflow dry-run: would reset ${rows[0]?.count ?? 0} research rows`);
    await db.end();
    return;
  }

  const { rowCount } = await db.query(
    `WITH target AS (
       SELECT id, canonical_poi_id FROM research_pois WHERE ${whereSql} FOR UPDATE
     ), retired AS (
       UPDATE research_canonical_memberships
       SET active = false, retired_at = now(), retirement_reason = 'reflow'
       WHERE active AND research_poi_id IN (SELECT id FROM target)
       RETURNING research_poi_id
     ), hidden AS (
       UPDATE canonical_pois cp SET status = 'hidden', updated_at = now()
       WHERE cp.origin = 'research'
         AND cp.id IN (
           SELECT t.canonical_poi_id FROM target t
           JOIN retired r ON r.research_poi_id = t.id
           WHERE t.canonical_poi_id IS NOT NULL
         )
         AND NOT EXISTS (
           SELECT 1 FROM research_canonical_memberships m
           WHERE m.canonical_poi_id = cp.id AND m.active
         )
     )
     UPDATE research_pois SET
       name_normalized = NULL,
       website_domain = NULL,
       category_slugs = NULL,
       content_embedding = NULL,
       starts_at = NULL,
       ends_at = NULL,
       date_precision = NULL,
       coordinate_source = NULL,
       coordinate_precision = NULL,
       geocode_query_norm = NULL,
       active_geocode_id = NULL,
       active_embedding_id = NULL,
       active_normalization_id = NULL,
       matched_normalization_id = NULL,
       normalization_state = 'pending',
       normalization_input_hash = NULL,
       normalized_at = NULL,
       canonical_poi_id = NULL
     WHERE id IN (SELECT id FROM target)`,
    params,
  );
  await db.end();
  console.log(`Reflow: reset ${rowCount ?? 0} research rows`);
}

main().catch((err) => {
  console.error("Reflow failed:", err);
  process.exit(1);
});
