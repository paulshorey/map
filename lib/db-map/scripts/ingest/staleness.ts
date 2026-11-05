/**
 * Which stored records were produced by older pipeline logic than the current code.
 *
 * Policy: outdated records are never upgraded in place. A source with outdated records is
 * purged (`ingest:purge`, or `ingest:clean <file>` per file) and re-ingested from its raw
 * captures. New runs refuse such sources (see `assertSourceCurrent`).
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:staleness [--source <slug>] [--json]
 */
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import { LOCATION_VERSION } from "./location.js";
import { allNormalizationProfileVersions } from "./normalize/profiles.js";
import { PROMPT_VERSION, SCHEMA_VERSION } from "./normalize/contracts.js";

export interface StalenessRow {
  source: string;
  records: number;
  /** Records with at least one artifact from older logic. */
  outdated: number;
  normalization: number;
  location: number;
  geocoder: number;
  matcher: number;
  canonical_build: number;
}

/**
 * Counts per source. Only artifacts that exist are judged: a record still pending a stage is
 * incomplete, not outdated.
 */
export async function stalenessBySource(
  db: Pool,
  source: string | null = null,
): Promise<StalenessRow[]> {
  const { rows } = await db.query(
    `WITH r AS (
      SELECT s.slug,
        (n.id IS NOT NULL AND (n.normalizer_version <> $2
          OR (q.id IS NOT NULL AND (q.prompt_version <> $3 OR q.schema_version <> $4
            OR NOT (q.profile_version = ANY($5::text[])))))) AS normalization,
        (rp.attributes->'location_enrichment'->>'version' IS NOT NULL
          AND rp.attributes->'location_enrichment'->>'version' <> $6) AS location,
        (g.id IS NOT NULL AND g.provider_version <> $7) AS geocoder,
        (m.id IS NOT NULL AND m.matcher_version <> $8) AS matcher,
        (b.id IS NOT NULL AND b.builder_version <> $9) AS canonical_build
      FROM research_pois rp
      JOIN research_sources s ON s.id=rp.source_id
      LEFT JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id
      LEFT JOIN research_normalization_requests q ON q.id=n.request_id
      LEFT JOIN research_poi_geocodes g ON g.id=rp.active_geocode_id
      LEFT JOIN research_canonical_memberships m ON m.research_poi_id=rp.id AND m.active
      LEFT JOIN canonical_pois c ON c.id=rp.canonical_poi_id
      LEFT JOIN canonical_poi_builds b ON b.id=c.active_build_id
      WHERE rp.retired_at IS NULL AND ($1::text IS NULL OR s.slug=$1)
    )
    SELECT slug AS source, count(*)::int AS records,
      count(*) FILTER (WHERE normalization OR location OR geocoder OR matcher OR canonical_build)::int AS outdated,
      count(*) FILTER (WHERE normalization)::int AS normalization,
      count(*) FILTER (WHERE location)::int AS location,
      count(*) FILTER (WHERE geocoder)::int AS geocoder,
      count(*) FILTER (WHERE matcher)::int AS matcher,
      count(*) FILTER (WHERE canonical_build)::int AS canonical_build
    FROM r GROUP BY slug ORDER BY records DESC`,
    [
      source,
      PIPELINE_VERSIONS.normalizer,
      PROMPT_VERSION,
      SCHEMA_VERSION,
      allNormalizationProfileVersions(),
      LOCATION_VERSION,
      PIPELINE_VERSIONS.geocode,
      PIPELINE_VERSIONS.matcher,
      PIPELINE_VERSIONS.canonicalBuilder,
    ],
  );
  return rows as StalenessRow[];
}

/** New runs refuse a source holding outdated records: purge and re-ingest it instead. */
export async function assertSourceCurrent(db: Pool, source: string): Promise<void> {
  const [row] = await stalenessBySource(db, source);
  if (!row?.outdated) return;
  throw Object.assign(
    new Error(
      `${row.outdated} of ${row.records} ${source} records were produced by older pipeline logic ` +
        `(normalization ${row.normalization}, location ${row.location}, geocoder ${row.geocoder}, ` +
        `matcher ${row.matcher}, canonical build ${row.canonical_build}). They are not upgraded in place: ` +
        "remove them with `pnpm --filter @lib/db-map ingest:clean <file>` for each of the source's files " +
        "(or `ingest:purge` for everything), then re-import. See `ingest:staleness`.",
    ),
    { code: "outdated_data" },
  );
}

async function main() {
  const args = process.argv.slice(2);
  const source = args.includes("--source") ? args[args.indexOf("--source") + 1]! : null;
  const db = getDb();
  try {
    const rows = await stalenessBySource(db, source);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ current: { ...PIPELINE_VERSIONS, location: LOCATION_VERSION }, sources: rows }, null, 2));
      return;
    }
    console.log(`Current: ${JSON.stringify({ ...PIPELINE_VERSIONS, location: LOCATION_VERSION })}`);
    console.table(rows);
    const outdated = rows.filter((r) => r.outdated > 0);
    console.log(
      outdated.length
        ? `${outdated.length} source(s) hold outdated records; purge and re-ingest them.`
        : "All stored records match the current pipeline.",
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
