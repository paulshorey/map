/**
 * Which stored records were produced by older pipeline logic than the current code.
 *
 * Policy, by what is outdated:
 *  - A record's own artifacts (normalization, location, geocode, embedding): never upgraded
 *    in place. The source is purged (`ingest:purge`, or `ingest:clean <file>` per file) and
 *    re-ingested from its raw captures.
 *  - Only the matching layer (matcher, canonical build): nothing about the record changed.
 *    Memberships and canonicals are derived wholly from stored records, so they are dropped
 *    and rebuilt for the whole database with `ingest:rebuild-canonicals`. No source is
 *    re-ingested and no record is normalized, geocoded or embedded again.
 * New runs refuse a source in either state (see `assertSourceCurrent`).
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:staleness [--source <slug>] [--json]
 */
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import { ingestConfig } from "./config.js";
import { LOCATION_VERSION } from "./location.js";
import { allNormalizationProfileVersions } from "./normalize/profiles.js";
import { PROMPT_VERSION, SCHEMA_VERSION } from "./normalize/contracts.js";

export interface StalenessRow {
  source: string;
  records: number;
  /** Records with at least one artifact from older logic. */
  outdated: number;
  /** Records whose own artifacts are outdated: the source must be re-ingested. */
  reingest: number;
  /** Records outdated only in matcher or canonical build: `ingest:rebuild-canonicals`. */
  rebuild: number;
  normalization: number;
  location: number;
  geocoder: number;
  embedding: number;
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
        -- Deterministic (--no-llm) artifacts have no request; their profile version is on the
        -- artifact. An artifact with no known profile version is treated as outdated.
        (n.id IS NOT NULL AND (n.normalizer_version <> $2
          OR (q.id IS NOT NULL AND (q.prompt_version <> $3 OR q.schema_version <> $4))
          OR NOT (COALESCE(q.profile_version, n.profile_version, '') = ANY($5::text[])))) AS normalization,
        (rp.attributes->'location_enrichment'->>'version' IS NOT NULL
          AND rp.attributes->'location_enrichment'->>'version' <> $6) AS location,
        (g.id IS NOT NULL AND g.provider_version <> $7) AS geocoder,
        (e.id IS NOT NULL AND (e.model <> $10 OR e.model_version <> $11
          OR array_length(e.embedding, 1) IS DISTINCT FROM $12::int)) AS embedding,
        (m.id IS NOT NULL AND m.matcher_version <> $8) AS matcher,
        (b.id IS NOT NULL AND b.builder_version <> $9) AS canonical_build
      FROM research_pois rp
      JOIN research_sources s ON s.id=rp.source_id
      LEFT JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id
      LEFT JOIN research_normalization_requests q ON q.id=n.request_id
      LEFT JOIN research_poi_geocodes g ON g.id=rp.active_geocode_id
      LEFT JOIN research_poi_embeddings e ON e.id=rp.active_embedding_id
      LEFT JOIN research_canonical_memberships m ON m.research_poi_id=rp.id AND m.active
      LEFT JOIN canonical_pois c ON c.id=rp.canonical_poi_id
      LEFT JOIN canonical_poi_builds b ON b.id=c.active_build_id
      WHERE rp.retired_at IS NULL AND ($1::text IS NULL OR s.slug=$1)
    )
    SELECT slug AS source, count(*)::int AS records,
      count(*) FILTER (WHERE normalization OR location OR geocoder OR embedding OR matcher OR canonical_build)::int AS outdated,
      count(*) FILTER (WHERE normalization OR location OR geocoder OR embedding)::int AS reingest,
      count(*) FILTER (WHERE (matcher OR canonical_build) AND NOT (normalization OR location OR geocoder OR embedding))::int AS rebuild,
      count(*) FILTER (WHERE normalization)::int AS normalization,
      count(*) FILTER (WHERE location)::int AS location,
      count(*) FILTER (WHERE geocoder)::int AS geocoder,
      count(*) FILTER (WHERE embedding)::int AS embedding,
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
      ingestConfig.embeddings.model,
      PIPELINE_VERSIONS.embedding,
      ingestConfig.embeddings.dim,
    ],
  );
  return rows as StalenessRow[];
}

const REBUILD_COMMAND =
  "pnpm --filter @lib/db-map ingest:rebuild-canonicals --maintenance-token <owned-token>";

/** Why a row is outdated and what to do; null when it is current. */
function remedy(row: StalenessRow): { code: string; message: string } | null {
  if (row.reingest)
    return {
      code: "outdated_data",
      message:
        `${row.reingest} of ${row.records} ${row.source} records were produced by older pipeline logic ` +
        `(normalization ${row.normalization}, location ${row.location}, geocoder ${row.geocoder}, ` +
        `embedding ${row.embedding}). They are not upgraded in place: ` +
        "remove them with `pnpm --filter @lib/db-map ingest:clean <file>` for each of the source's files " +
        "(or `ingest:purge` for everything), then re-import. See `ingest:staleness`.",
    };
  if (row.rebuild)
    return {
      code: "outdated_canonicals",
      message:
        `${row.rebuild} of ${row.records} ${row.source} records were matched or built by older logic ` +
        `(matcher ${row.matcher}, canonical build ${row.canonical_build}). The records themselves are current: ` +
        `rebuild the canonicals with \`${REBUILD_COMMAND}\`; nothing is re-ingested. See \`ingest:staleness\`.`,
    };
  return null;
}

/** New runs refuse a source holding outdated records; the error names the remedy. */
export async function assertSourceCurrent(db: Pool, source: string): Promise<void> {
  const rows = await stalenessBySource(db);
  const own = rows.find((row) => row.source === source);
  // Outdated records concern only their own source. Matching reads every source's
  // canonicals, so an outdated matching layer anywhere blocks every new run.
  const problem =
    (own && remedy(own)) ??
    rows.map((row) => (row.reingest ? null : remedy(row))).find((p) => p !== null);
  if (problem) throw Object.assign(new Error(problem.message), { code: problem.code });
}

/**
 * Guard for the standalone stage commands (`ingest:normalize`, `ingest:geocode`,
 * `ingest:match`): they write over every selected record, so they refuse to run while any
 * selected source (all sources when none is named) holds outdated records.
 */
export async function assertNoOutdatedSources(db: Pool, source: string | null): Promise<void> {
  const problems = (await stalenessBySource(db, source)).map(remedy).filter((p) => p !== null);
  if (!problems.length) return;
  throw Object.assign(new Error(problems.map((p) => p.message).join("\n")), {
    code: problems.some((p) => p.code === "outdated_data") ? "outdated_data" : "outdated_canonicals",
  });
}

/**
 * Guard for rebuilding canonicals: matching reads every record, so no source may hold
 * records that themselves need re-ingesting.
 */
export async function assertRecordsCurrent(db: Pool): Promise<void> {
  const stale = (await stalenessBySource(db)).filter((row) => row.reingest > 0);
  if (!stale.length) return;
  throw Object.assign(
    new Error(
      `Records need re-ingesting first: ${stale.map((r) => `${r.source} (${r.reingest})`).join(", ")}. ` +
        "Rebuilding canonicals only helps when the records themselves are current (see ingest:staleness).",
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
    const reingest = rows.filter((r) => r.reingest > 0);
    const rebuild = rows.some((r) => r.rebuild > 0);
    if (reingest.length)
      console.log(
        `Re-ingest (ingest:clean each file, then import again): ${reingest.map((r) => r.source).join(", ")}.`,
      );
    if (rebuild)
      console.log(
        `Matching or canonical builds are outdated${reingest.length ? " (after the re-ingest above)" : ""}: ${REBUILD_COMMAND}`,
      );
    if (!reingest.length && !rebuild)
      console.log("All stored records match the current pipeline.");
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
