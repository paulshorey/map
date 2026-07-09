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
    `UPDATE research_pois SET
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
       canonical_poi_id = NULL
     WHERE ${whereSql}`,
    params,
  );
  await db.end();
  console.log(`Reflow: reset ${rowCount ?? 0} research rows`);
}

main().catch((err) => {
  console.error("Reflow failed:", err);
  process.exit(1);
});
