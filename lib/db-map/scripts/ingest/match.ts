/**
 * Match research_pois into canonical_pois (M8).
 *
 * Resumable loop over rows where canonical_poi_id IS NULL and coordinates exist.
 * Each row is processed in its own transaction: decide merge/new, audit the decision,
 * attach/create a canonical POI, then rebuild that canonical from linked research rows.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:match [--source <slug>] [--limit N] [--dry-run] [--no-llm]
 *   pnpm --filter @lib/db-map ingest:match --consolidate-only [--dry-run] [--no-llm]
 *   pnpm --filter @lib/db-map ingest:match --recluster [--consolidate]
 *   pnpm --filter @lib/db-map ingest:match --gc-orphans
 */
import type { Pool, PoolClient } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { ingestConfig } from "./config.js";
import { rebuildCanonicalPoi } from "./merge.js";
import {
  distinctiveName,
  isAnchor,
  isSatelliteLikeResearch,
  isWithinProximityBox,
  normalizedExactName,
  pairNameSimilarity,
  proximityDegFor,
} from "./match/anchors.js";
import { collapseDuplicateCanonicals } from "./match/canonicals.js";
import { runConsolidation } from "./match/consolidate.js";
import { dateCompatibility, type DateCompatibilitySignal } from "./match/dates.js";
import { bboxAround, haversineMeters } from "./match/geo.js";
import { extractStrongIds } from "./match/ids.js";
import { adjudicateMatch } from "./match/llm.js";
import { scoreCandidate, type CandidateScore } from "./match/score.js";
import { LlmError } from "./providers/deepinfra.js";

const ADVISORY_LOCK_ID = 0x5018a;
const MATCHER_VERSION = "matcher-v1";
const DEFAULT_RADIUS_M = 300;
const RADIUS_BY_SLUG: Record<string, number> = {
  gardens: 600,
  botanical_garden: 600,
  arboretum: 600,
  campground: 200,
  rv: 150,
  tent: 150,
  music_festival: 1_000,
  carnival: 1_000,
  art_fair: 800,
  art_parade: 800,
};

interface CliOptions {
  source?: string;
  limit?: number;
  dryRun: boolean;
  noLlm: boolean;
  recluster: boolean;
  gcOrphans: boolean;
  consolidate: boolean;
  consolidateOnly: boolean;
  tHigh: number;
  tLow: number;
}

interface MatchStats {
  processed: number;
  merged: number;
  created: number;
  llm: number;
  auto: number;
  strongId: number;
  override: number;
  proximity: number;
  skipped: number;
  garbageCollected: number;
  consolidated: number;
  stopped: boolean;
}

interface MatchSnapshot {
  linked: number;
  pending: number;
  missingCoords: number;
  missingName: number;
  missingCategories: number;
  canonicals: number;
  decisionsByMethod: Record<string, number>;
}

interface ShutdownSignal {
  requested: boolean;
  count: number;
}

interface ResearchMatchRow {
  id: string;
  source_id: string;
  source_slug: string;
  source_trust: number;
  source_record_id: string;
  name: string | null;
  name_normalized: string | null;
  description: string | null;
  website: string | null;
  website_domain: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  lng: number;
  lat: number;
  starts_at: Date | null;
  ends_at: Date | null;
  date_precision: string | null;
  category_slugs: string[] | null;
  content_embedding: number[] | null;
  coordinate_precision: string | null;
  attributes: Record<string, unknown> | null;
  raw: unknown;
}

interface CandidateRow {
  canonical_id: string;
  canonical_name: string;
  canonical_lat: number;
  canonical_lng: number;
  canonical_website: string | null;
  canonical_phone: string | null;
  canonical_address: string | null;
  canonical_starts_at: Date | null;
  canonical_ends_at: Date | null;
  canonical_date_precision: string | null;
  canonical_popularity: number;
  canonical_has_website: boolean;
  canonical_has_wikidata_qid: boolean;
  canonical_max_source_trust: number;
  best_research_id: string | null;
  best_name: string | null;
  best_name_normalized: string | null;
  best_content_embedding: number[] | null;
  best_website_domain: string | null;
  best_phone: string | null;
  best_address: string | null;
  best_city: string | null;
  best_region: string | null;
  best_country_code: string | null;
  best_coordinate_precision: string | null;
  best_starts_at: Date | null;
  best_ends_at: Date | null;
  best_date_precision: string | null;
  distance_m: number;
  via: Array<"spatial" | "proximity" | "name">;
  score?: CandidateScore;
  dateCompatibility?: DateCompatibilitySignal;
}

interface Decision {
  decision: "merge" | "new";
  method: "strong_id" | "auto" | "llm" | "override" | "proximity";
  candidatePoiId: string | null;
  duplicateCanonicalIds?: string[];
  score: number | null;
  signals: Record<string, unknown>;
  llmReason: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let limit: number | undefined;
  let dryRun = false;
  let noLlm = false;
  let recluster = false;
  let gcOrphans = false;
  let consolidate = false;
  let consolidateOnly = false;
  let tHigh = ingestConfig.match.tHigh;
  let tLow = ingestConfig.match.tLow;

  const requireValue = (flag: string): string => {
    const value = argv[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    return value;
  };

  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--no-llm") noLlm = true;
    else if (a === "--recluster") recluster = true;
    else if (a === "--gc-orphans") gcOrphans = true;
    else if (a === "--consolidate") consolidate = true;
    else if (a === "--consolidate-only") {
      consolidate = true;
      consolidateOnly = true;
    }
    else if (a === "--source") source = requireValue(a);
    else if (a === "--limit") limit = Number(requireValue(a));
    else if (a === "--auto-threshold") tHigh = Number(requireValue(a));
    else if (a === "--low-threshold") tLow = Number(requireValue(a));
    else throw new Error(`Unknown or incomplete argument: ${a}`);
  }

  for (const [name, val] of [
    ["--limit", limit],
    ["--auto-threshold", tHigh],
    ["--low-threshold", tLow],
  ] as const) {
    if (val !== undefined && (!Number.isFinite(val) || val < 0)) {
      throw new Error(`Invalid ${name}: ${val}`);
    }
  }
  if (tLow >= tHigh) throw new Error("--low-threshold must be lower than --auto-threshold");
  if (recluster && dryRun) throw new Error("--recluster cannot be combined with --dry-run");
  if (recluster && source) throw new Error("--recluster rebuilds all canonicals; run without --source");
  if (recluster && limit !== undefined) throw new Error("--recluster rebuilds all canonicals; run without --limit");
  if (consolidateOnly && recluster) {
    throw new Error("--consolidate-only cannot be combined with --recluster");
  }
  if (consolidateOnly && source) {
    throw new Error("--consolidate-only runs across canonicals; run without --source");
  }
  if (consolidateOnly && limit !== undefined) {
    throw new Error("--consolidate-only skips row matching; run without --limit");
  }
  if (consolidateOnly && gcOrphans) {
    throw new Error("--consolidate-only cannot be combined with --gc-orphans");
  }
  return { source, limit, dryRun, noLlm, recluster, gcOrphans, consolidate, consolidateOnly, tHigh, tLow };
}

async function resolveSourceId(client: PoolClient, slug: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM research_sources WHERE slug = $1`,
    [slug],
  );
  if (rows.length === 0) throw new Error(`Unknown source slug: ${slug}`);
  return rows[0]!.id;
}

function radiusFor(slugs: string[] | null): number {
  if (!slugs || slugs.length === 0) return DEFAULT_RADIUS_M;
  return Math.max(...slugs.map((slug) => RADIUS_BY_SLUG[slug] ?? DEFAULT_RADIUS_M));
}

function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

function decisionSummary(decisionsByMethod: Record<string, number>): string {
  const entries = Object.entries(decisionsByMethod).sort(([a], [b]) => a.localeCompare(b));
  return entries.length > 0
    ? entries.map(([method, count]) => `${method}=${formatInt(count)}`).join(" ")
    : "none";
}

function resumeCommand(opts: CliOptions): string {
  const args = ["pnpm", "--filter", "@lib/db-map", "ingest:match"];
  if (opts.source) args.push("--source", opts.source);
  if (opts.noLlm) args.push("--no-llm");
  if (opts.consolidateOnly) args.push("--consolidate-only");
  else if (opts.consolidate) args.push("--consolidate");
  if (opts.limit !== undefined && !opts.consolidateOnly) args.push("--limit", String(opts.limit));
  return args.join(" ");
}

async function loadMatchSnapshot(client: Pool | PoolClient, sourceSlug?: string): Promise<MatchSnapshot> {
  const { rows } = await client.query<{
    linked: string;
    pending: string;
    missing_coords: string;
    missing_name: string;
    missing_categories: string;
  }>(
    `SELECT
       count(*) FILTER (WHERE rp.canonical_poi_id IS NOT NULL)::text AS linked,
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL
           AND rp.is_poi
           AND rp.lat IS NOT NULL
           AND rp.lng IS NOT NULL
           AND rp.name_normalized IS NOT NULL
           AND rp.category_slugs IS NOT NULL
       )::text AS pending,
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL
           AND rp.is_poi
           AND (rp.lat IS NULL OR rp.lng IS NULL)
       )::text AS missing_coords,
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL
           AND rp.is_poi
           AND rp.lat IS NOT NULL
           AND rp.lng IS NOT NULL
           AND rp.name_normalized IS NULL
       )::text AS missing_name,
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL
           AND rp.is_poi
           AND rp.lat IS NOT NULL
           AND rp.lng IS NOT NULL
           AND rp.name_normalized IS NOT NULL
           AND rp.category_slugs IS NULL
       )::text AS missing_categories
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE ($1::text IS NULL OR rs.slug = $1)`,
    [sourceSlug ?? null],
  );
  const counts = rows[0];

  const canonicalCount = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM canonical_pois`,
  );
  const decisionCounts = await client.query<{ method: string; count: string }>(
    `SELECT rmd.method, count(*)::text AS count
     FROM research_match_decisions rmd
     JOIN research_pois rp ON rp.id = rmd.research_id
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE ($1::text IS NULL OR rs.slug = $1)
     GROUP BY rmd.method
     ORDER BY rmd.method`,
    [sourceSlug ?? null],
  );

  return {
    linked: Number(counts?.linked ?? 0),
    pending: Number(counts?.pending ?? 0),
    missingCoords: Number(counts?.missing_coords ?? 0),
    missingName: Number(counts?.missing_name ?? 0),
    missingCategories: Number(counts?.missing_categories ?? 0),
    canonicals: Number(canonicalCount.rows[0]?.count ?? 0),
    decisionsByMethod: Object.fromEntries(
      decisionCounts.rows.map((row) => [row.method, Number(row.count)]),
    ),
  };
}

function printStartupBanner(opts: CliOptions, snapshot: MatchSnapshot): void {
  const mode = opts.recluster
    ? "recluster (destructive)"
    : opts.consolidateOnly
      ? "consolidate-only"
      : opts.dryRun
        ? "dry-run"
        : "resume";

  console.log(
    [
      "ingest:match",
      `mode: ${mode}`,
      `source: ${opts.source ?? "all"}`,
      `llm: ${opts.noLlm ? "disabled" : "enabled"}`,
      `linked: ${formatInt(snapshot.linked)}`,
      `pending: ${formatInt(snapshot.pending)}`,
      `not ready: coords=${formatInt(snapshot.missingCoords)} name=${formatInt(snapshot.missingName)} categories=${formatInt(snapshot.missingCategories)}`,
      `canonicals: ${formatInt(snapshot.canonicals)}`,
      `previous decisions: ${decisionSummary(snapshot.decisionsByMethod)}`,
      `resume command: ${resumeCommand({ ...opts, recluster: false })}`,
    ].join("\n"),
  );

  if (opts.recluster) {
    console.warn(
      [
        "WARNING: --recluster starts over.",
        `It will unlink ${formatInt(snapshot.linked)} research rows, delete match decisions, and delete ${formatInt(snapshot.canonicals)} canonicals.`,
        `Use normal resume instead: ${resumeCommand({ ...opts, recluster: false, consolidate: opts.consolidate || opts.consolidateOnly, consolidateOnly: false })}`,
      ].join("\n"),
    );
  }
}

async function fetchNextRow(
  client: PoolClient,
  sourceId: string | null,
  excludedIds: Set<string> = new Set(),
): Promise<ResearchMatchRow | null> {
  const params: unknown[] = [];
  let sourceClause = "";
  if (sourceId) {
    params.push(sourceId);
    sourceClause = `AND rp.source_id = $${params.length}`;
  }
  let excludedClause = "";
  if (excludedIds.size > 0) {
    params.push([...excludedIds]);
    excludedClause = `AND NOT (rp.id = ANY($${params.length}::uuid[]))`;
  }

  const { rows } = await client.query<ResearchMatchRow>(
    `SELECT
       rp.id, rp.source_id, rs.slug AS source_slug, rs.trust AS source_trust,
       rp.source_record_id, rp.name, rp.name_normalized, rp.description,
       rp.website, rp.website_domain, rp.phone, rp.address,
       rp.city, rp.region, rp.country_code, rp.lng, rp.lat,
       rp.starts_at, rp.ends_at, rp.date_precision,
       rp.category_slugs, rp.content_embedding, rp.coordinate_precision,
       rp.attributes, rp.raw
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE rp.canonical_poi_id IS NULL
       AND rp.is_poi
       AND rp.lat IS NOT NULL
       AND rp.lng IS NOT NULL
       AND rp.name_normalized IS NOT NULL
       AND rp.category_slugs IS NOT NULL
       ${sourceClause}
       ${excludedClause}
     ORDER BY rp.first_seen_at, rp.id
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    params,
  );
  return rows[0] ?? null;
}

async function loadOverrideDecision(
  client: PoolClient,
  rowId: string,
): Promise<{ forceNew: boolean; forceSameCanonicalId: string | null; forceDifferentCanonicalIds: Set<string> }> {
  const forceSame = await client.query<{ canonical_poi_id: string }>(
    `SELECT other.canonical_poi_id
     FROM research_match_overrides o
     JOIN research_pois other ON other.id = CASE WHEN o.record_a = $1 THEN o.record_b ELSE o.record_a END
     WHERE (o.record_a = $1 OR o.record_b = $1)
       AND o.rule = 'force_same'
       AND other.canonical_poi_id IS NOT NULL
     ORDER BY o.created_at DESC
     LIMIT 1`,
    [rowId],
  );

  const forceDifferent = await client.query<{ canonical_poi_id: string | null; force_new: boolean }>(
    `SELECT other.canonical_poi_id, false AS force_new
     FROM research_match_overrides o
     JOIN research_pois other ON other.id = CASE WHEN o.record_a = $1 THEN o.record_b ELSE o.record_a END
     WHERE (o.record_a = $1 OR o.record_b = $1)
       AND o.rule = 'force_different'
       AND other.canonical_poi_id IS NOT NULL
     UNION ALL
     SELECT NULL AS canonical_poi_id, true AS force_new
     FROM research_match_overrides o
     WHERE o.record_a = $1 AND o.record_b IS NULL AND o.rule = 'force_different'`,
    [rowId],
  );

  return {
    forceNew: forceDifferent.rows.some((r) => r.force_new),
    forceSameCanonicalId: forceSame.rows[0]?.canonical_poi_id ?? null,
    forceDifferentCanonicalIds: new Set(
      forceDifferent.rows
        .map((r) => r.canonical_poi_id)
        .filter((id): id is string => id !== null),
    ),
  };
}

async function findStrongIdCanonicalIds(
  client: PoolClient,
  row: ResearchMatchRow,
  excluded: Set<string>,
): Promise<string[]> {
  const ids = extractStrongIds(row);
  const clauses: string[] = [];
  const params: unknown[] = [row.id];

  if (ids.wikidata.length > 0) {
    params.push(ids.wikidata);
    const p = `$${params.length}`;
    clauses.push(`(
      rp.source_record_id = ANY(${p})
      OR rp.attributes->>'wikidata_id' = ANY(${p})
      OR rp.attributes->>'wikidata' = ANY(${p})
      OR rp.raw->>'wikidata_id' = ANY(${p})
      OR rp.raw->>'wikidata' = ANY(${p})
    )`);
  }

  if (ids.osm.length > 0) {
    params.push(ids.osm);
    const p = `$${params.length}`;
    clauses.push(`(
      lower(rp.source_record_id) = ANY(${p})
      OR lower(concat(coalesce(rp.attributes->>'osm_type', 'node'), '/', rp.attributes->>'osm_id')) = ANY(${p})
      OR lower(concat(coalesce(rp.raw->>'osm_type', 'node'), '/', rp.raw->>'osm_id')) = ANY(${p})
    )`);
  }

  if (clauses.length === 0) return [];

  const { rows } = await client.query<{ canonical_poi_id: string; trust: number }>(
    `SELECT rp.canonical_poi_id, max(rs.trust)::int AS trust
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE rp.id <> $1
       AND rp.canonical_poi_id IS NOT NULL
       AND (${clauses.join(" OR ")})
     GROUP BY rp.canonical_poi_id
     ORDER BY trust DESC`,
    params,
  );

  return rows
    .map((r) => r.canonical_poi_id)
    .filter((id) => !excluded.has(id));
}

async function fetchCandidates(
  client: PoolClient,
  row: ResearchMatchRow,
  excluded: Set<string>,
): Promise<CandidateRow[]> {
  const radiusM = radiusFor(row.category_slugs);
  const bbox = bboxAround({ lat: row.lat, lng: row.lng }, radiusM);
  const nameBlockM = ingestConfig.match.nameBlockKm * 1000;
  const nameBbox = bboxAround({ lat: row.lat, lng: row.lng }, nameBlockM);
  const proximityDeg = proximityDegFor(row.category_slugs);
  const { rows } = await client.query<
    Omit<CandidateRow, "distance_m" | "via"> & {
      via_spatial: boolean;
      via_proximity: boolean;
      via_name: boolean;
    }
  >(
    `SELECT
       cp.id AS canonical_id,
       cp.name AS canonical_name,
       cp.lat AS canonical_lat,
       cp.lng AS canonical_lng,
       cp.website AS canonical_website,
       cp.phone AS canonical_phone,
       cp.address AS canonical_address,
       cp.starts_at AS canonical_starts_at,
       cp.ends_at AS canonical_ends_at,
       cp.date_precision AS canonical_date_precision,
       cp.popularity AS canonical_popularity,
       COALESCE(meta.has_website, cp.website IS NOT NULL) AS canonical_has_website,
       COALESCE(meta.has_wikidata_qid, false) AS canonical_has_wikidata_qid,
       COALESCE(meta.max_source_trust, 0) AS canonical_max_source_trust,
       br.id AS best_research_id,
       br.name AS best_name,
       br.name_normalized AS best_name_normalized,
       br.content_embedding AS best_content_embedding,
       br.website_domain AS best_website_domain,
       br.phone AS best_phone,
       br.address AS best_address,
       br.city AS best_city,
       br.region AS best_region,
       br.country_code AS best_country_code,
       br.coordinate_precision AS best_coordinate_precision,
       br.starts_at AS best_starts_at,
       br.ends_at AS best_ends_at,
       br.date_precision AS best_date_precision,
       (cp.lat BETWEEN $1 AND $2 AND cp.lng BETWEEN $3 AND $4) AS via_spatial,
       ($8::double precision > 0 AND abs(cp.lat - $6) <= $8 AND abs(cp.lng - $7) <= $8) AS via_proximity,
       (
         cp.lat BETWEEN $9 AND $10
         AND cp.lng BETWEEN $11 AND $12
         AND lower(cp.name) % $13
         AND similarity(lower(cp.name), $13) >= 0.9
       ) AS via_name
     FROM canonical_pois cp
     JOIN LATERAL (
       SELECT
         max(rs.trust)::int AS max_source_trust,
         bool_or(rp.website IS NOT NULL OR cp.website IS NOT NULL) AS has_website,
         bool_or(
           rp.attributes->>'wikidata_id' IS NOT NULL
           OR rp.attributes->>'wikidata' IS NOT NULL
           OR rp.raw->>'wikidata_id' IS NOT NULL
           OR rp.raw->>'wikidata' IS NOT NULL
           OR rp.source_record_id ~* '^Q[0-9]+$'
         ) AS has_wikidata_qid
       FROM research_pois rp
       JOIN research_sources rs ON rs.id = rp.source_id
       WHERE rp.canonical_poi_id = cp.id AND rp.is_poi
     ) meta ON true
     LEFT JOIN LATERAL (
       SELECT rp.*, rs.trust
       FROM research_pois rp
       JOIN research_sources rs ON rs.id = rp.source_id
       WHERE rp.canonical_poi_id = cp.id AND rp.is_poi
       ORDER BY rs.trust DESC, (rp.content_embedding IS NOT NULL) DESC, rp.last_seen_at DESC
       LIMIT 1
     ) br ON true
     WHERE cp.status <> 'hidden'
       AND EXISTS (
         SELECT 1
         FROM canonical_poi_categories cpc
         JOIN canonical_categories cc ON cc.id = cpc.category_id
         WHERE cpc.poi_id = cp.id
           AND cc.slug = ANY($5::text[])
       )
       AND (
         (cp.lat BETWEEN $1 AND $2 AND cp.lng BETWEEN $3 AND $4)
         OR ($8::double precision > 0 AND abs(cp.lat - $6) <= $8 AND abs(cp.lng - $7) <= $8)
         OR (
           cp.lat BETWEEN $9 AND $10
           AND cp.lng BETWEEN $11 AND $12
           AND lower(cp.name) % $13
           AND similarity(lower(cp.name), $13) >= 0.9
         )
       )
     LIMIT 250`,
    [
      bbox.minLat,
      bbox.maxLat,
      bbox.minLng,
      bbox.maxLng,
      row.category_slugs ?? [],
      row.lat,
      row.lng,
      proximityDeg,
      nameBbox.minLat,
      nameBbox.maxLat,
      nameBbox.minLng,
      nameBbox.maxLng,
      row.name_normalized ?? row.name ?? "",
    ],
  );

  return rows
    .filter((candidate) => !excluded.has(candidate.canonical_id))
    .map((candidate): CandidateRow => {
      const distance_m = haversineMeters(
        { lat: row.lat, lng: row.lng },
        { lat: candidate.canonical_lat, lng: candidate.canonical_lng },
      );
      const via: CandidateRow["via"] = [];
      if (candidate.via_spatial && distance_m <= radiusM) via.push("spatial");
      if (
        candidate.via_proximity &&
        isWithinProximityBox(
          { lat: row.lat, lng: row.lng },
          { lat: candidate.canonical_lat, lng: candidate.canonical_lng },
          row.category_slugs,
        )
      ) {
        via.push("proximity");
      }
      if (candidate.via_name && distance_m <= nameBlockM) via.push("name");

      const { via_spatial, via_proximity, via_name, ...rest } = candidate;
      void via_spatial;
      void via_proximity;
      void via_name;
      return { ...rest, distance_m, via };
    })
    .filter((candidate) => candidate.via.length > 0)
    .sort((a, b) => {
      const aPriority = a.via.includes("proximity") ? 0 : a.via.includes("spatial") ? 1 : 2;
      const bPriority = b.via.includes("proximity") ? 0 : b.via.includes("spatial") ? 1 : 2;
      return aPriority - bPriority || a.distance_m - b.distance_m;
    })
    .slice(0, 40);
}

function scoreCandidates(row: ResearchMatchRow, candidates: CandidateRow[]): CandidateRow[] {
  const radiusM = radiusFor(row.category_slugs);
  for (const candidate of candidates) {
    candidate.score = scoreCandidate({
      current: row,
      candidate: {
        name: candidate.best_name ?? candidate.canonical_name,
        name_normalized: candidate.best_name_normalized ?? candidate.canonical_name,
        content_embedding: candidate.best_content_embedding,
        website_domain: candidate.best_website_domain ?? candidate.canonical_website,
        phone: candidate.best_phone ?? candidate.canonical_phone,
        city: candidate.best_city,
        region: candidate.best_region,
        country_code: candidate.best_country_code,
        coordinate_precision: candidate.best_coordinate_precision,
      },
      distanceM: candidate.distance_m,
      radiusM,
    });
    candidate.dateCompatibility = dateCompatibility({
      current: row,
      candidate: {
        starts_at: candidate.best_starts_at ?? candidate.canonical_starts_at,
        ends_at: candidate.best_ends_at ?? candidate.canonical_ends_at,
        date_precision: candidate.best_date_precision ?? candidate.canonical_date_precision,
      },
      nameSimilarity: candidate.score.signals.name,
      semanticSimilarity: candidate.score.signals.semantic,
      localitySimilarity: candidate.score.signals.locality,
      distanceM: candidate.distance_m,
    });
  }
  return candidates.sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0));
}

function candidateAnchorMeta(candidate: CandidateRow) {
  return {
    canonical_id: candidate.canonical_id,
    popularity: candidate.canonical_popularity,
    max_source_trust: candidate.canonical_max_source_trust,
    has_website: candidate.canonical_has_website,
    has_wikidata_qid: candidate.canonical_has_wikidata_qid,
  };
}

function candidateName(candidate: CandidateRow): string | null {
  return candidate.best_name_normalized ?? candidate.best_name ?? candidate.canonical_name;
}

function dateSignalForCandidate(
  row: ResearchMatchRow,
  candidate: CandidateRow,
  nameSignal: number,
): DateCompatibilitySignal {
  return dateCompatibility({
    current: row,
    candidate: {
      starts_at: candidate.best_starts_at ?? candidate.canonical_starts_at,
      ends_at: candidate.best_ends_at ?? candidate.canonical_ends_at,
      date_precision: candidate.best_date_precision ?? candidate.canonical_date_precision,
    },
    nameSimilarity: nameSignal,
    semanticSimilarity: nameSignal,
    localitySimilarity: 0,
    distanceM: candidate.distance_m,
  });
}

async function llmDecisionForCandidate(
  row: ResearchMatchRow,
  candidate: CandidateRow,
  score: CandidateScore,
  signals: Record<string, unknown>,
): Promise<Decision> {
  try {
    const llm = await adjudicateMatch({
      current: {
        name: row.name,
        address: row.address,
        city: row.city,
        region: row.region,
        country_code: row.country_code,
        lat: row.lat,
        lng: row.lng,
        website: row.website,
        phone: row.phone,
        categories: row.category_slugs,
        coordinate_precision: row.coordinate_precision,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        date_precision: row.date_precision,
      },
      candidate: {
        name: candidate.best_name ?? candidate.canonical_name,
        canonical_name: candidate.canonical_name,
        address: candidate.best_address ?? candidate.canonical_address,
        city: candidate.best_city,
        region: candidate.best_region,
        country_code: candidate.best_country_code,
        lat: candidate.canonical_lat,
        lng: candidate.canonical_lng,
        website: candidate.best_website_domain ?? candidate.canonical_website,
        phone: candidate.best_phone ?? candidate.canonical_phone,
        coordinate_precision: candidate.best_coordinate_precision,
        starts_at: candidate.best_starts_at ?? candidate.canonical_starts_at,
        ends_at: candidate.best_ends_at ?? candidate.canonical_ends_at,
        date_precision: candidate.best_date_precision ?? candidate.canonical_date_precision,
      },
      distance_m: Math.round(candidate.distance_m),
      score: score.score,
      signals,
    });

    return {
      decision: llm.samePlace ? "merge" : "new",
      method: "llm",
      candidatePoiId: candidate.canonical_id,
      score: score.score,
      signals,
      llmReason: llm.reason,
    };
  } catch (err) {
    // Conservative fallback (M0.4): an LLM/API failure must never auto-merge.
    const message = err instanceof LlmError ? err.message : (err as Error).message;
    console.warn(`Skipped LLM - ${row.name ?? row.id} - ${message}`);
    return {
      decision: "new",
      method: "auto",
      candidatePoiId: candidate.canonical_id,
      score: score.score,
      signals: { ...signals, reason: "llm_error" },
      llmReason: message,
    };
  }
}

async function decideRow(
  client: PoolClient,
  row: ResearchMatchRow,
  opts: CliOptions,
): Promise<Decision> {
  const overrides = await loadOverrideDecision(client, row.id);
  if (overrides.forceNew) {
    return {
      decision: "new",
      method: "override",
      candidatePoiId: null,
      score: null,
      signals: { override: "force_different_all" },
      llmReason: null,
    };
  }
  if (overrides.forceSameCanonicalId) {
    return {
      decision: "merge",
      method: "override",
      candidatePoiId: overrides.forceSameCanonicalId,
      score: 1,
      signals: { override: "force_same" },
      llmReason: null,
    };
  }

  const strongMatches = await findStrongIdCanonicalIds(
    client,
    row,
    overrides.forceDifferentCanonicalIds,
  );
  if (strongMatches.length > 0) {
    const [target, ...duplicates] = strongMatches;
    return {
      decision: "merge",
      method: "strong_id",
      candidatePoiId: target!,
      duplicateCanonicalIds: duplicates,
      score: 1,
      signals: {
        strong_ids: extractStrongIds(row),
        duplicate_canonical_ids: duplicates,
      },
      llmReason: null,
    };
  }

  const fetchedCandidates = await fetchCandidates(client, row, overrides.forceDifferentCanonicalIds);

  const proximityAnchor = fetchedCandidates
    .filter((candidate) => candidate.via.includes("proximity") && isAnchor(candidateAnchorMeta(candidate)))
    .sort((a, b) => a.distance_m - b.distance_m)[0];

  if (proximityAnchor) {
    const candidateSimilarity = pairNameSimilarity(row.name_normalized ?? row.name, candidateName(proximityAnchor));
    const dateSignal = dateSignalForCandidate(row, proximityAnchor, candidateSimilarity);
    if (!dateSignal.conflict && isSatelliteLikeResearch(row, candidateSimilarity)) {
      return {
        decision: "merge",
        method: "proximity",
        candidatePoiId: proximityAnchor.canonical_id,
        score: null,
        signals: {
          reason: "satellite_anchor_proximity",
          best_candidate: proximityAnchor.canonical_id,
          distance_m: Math.round(proximityAnchor.distance_m),
          proximity_deg: proximityDegFor(row.category_slugs),
          name_similarity: candidateSimilarity,
          date_compatibility: dateSignal,
          via: proximityAnchor.via,
        },
        llmReason: null,
      };
    }
  }

  const candidates = scoreCandidates(row, fetchedCandidates);

  if (candidates.length === 0) {
    return {
      decision: "new",
      method: "auto",
      candidatePoiId: null,
      score: null,
      signals: { reason: "no_candidates", radius_m: radiusFor(row.category_slugs) },
      llmReason: null,
    };
  }

  const best = candidates[0]!;
  const score = best.score!;
  const dateSignal = best.dateCompatibility!;
  const baseSignals = {
    best_candidate: best.canonical_id,
    distance_m: Math.round(best.distance_m),
    radius_m: radiusFor(row.category_slugs),
    proximity_deg: proximityDegFor(row.category_slugs),
    via: best.via,
    date_compatibility: dateSignal,
    signals: score.signals,
  };

  const exactNameProximity = candidates.find((candidate) => {
    return (
      candidate.via.includes("proximity") &&
      normalizedExactName(row.name_normalized ?? row.name, candidateName(candidate)) &&
      !candidate.dateCompatibility!.conflict
    );
  });
  if (exactNameProximity) {
    return {
      decision: "merge",
      method: "auto",
      candidatePoiId: exactNameProximity.canonical_id,
      score: exactNameProximity.score!.score,
      signals: {
        reason: "exact_name_proximity",
        best_candidate: exactNameProximity.canonical_id,
        distance_m: Math.round(exactNameProximity.distance_m),
        proximity_deg: proximityDegFor(row.category_slugs),
        via: exactNameProximity.via,
        date_compatibility: exactNameProximity.dateCompatibility,
        signals: exactNameProximity.score!.signals,
      },
      llmReason: null,
    };
  }

  const distinctiveNameBlock = candidates.find(
    (candidate) =>
      candidate.via.includes("name") &&
      normalizedExactName(row.name_normalized ?? row.name, candidateName(candidate)) &&
      distinctiveName(row.name_normalized ?? row.name) &&
      !candidate.dateCompatibility!.conflict,
  );
  if (distinctiveNameBlock) {
    return {
      decision: "merge",
      method: "auto",
      candidatePoiId: distinctiveNameBlock.canonical_id,
      score: distinctiveNameBlock.score!.score,
      signals: {
        reason: "distinctive_exact_name_name_block",
        best_candidate: distinctiveNameBlock.canonical_id,
        distance_m: Math.round(distinctiveNameBlock.distance_m),
        name_block_km: ingestConfig.match.nameBlockKm,
        via: distinctiveNameBlock.via,
        date_compatibility: distinctiveNameBlock.dateCompatibility,
        signals: distinctiveNameBlock.score!.signals,
      },
      llmReason: null,
    };
  }

  const anchorProximity = candidates.find(
    (candidate) =>
      candidate.via.includes("proximity") &&
      isAnchor(candidateAnchorMeta(candidate)) &&
      !isSatelliteLikeResearch(row, candidate.score!.signals.name) &&
      !candidate.dateCompatibility!.conflict,
  );
  if (anchorProximity) {
    const anchorScore = anchorProximity.score!;
    const anchorSignals = {
      best_candidate: anchorProximity.canonical_id,
      distance_m: Math.round(anchorProximity.distance_m),
      radius_m: radiusFor(row.category_slugs),
      proximity_deg: proximityDegFor(row.category_slugs),
      via: anchorProximity.via,
      date_compatibility: anchorProximity.dateCompatibility,
      signals: anchorScore.signals,
      match_context: "nearby same-category anchor/complex candidate",
    };
    if (opts.noLlm || opts.dryRun) {
      return {
        decision: "new",
        method: "auto",
        candidatePoiId: anchorProximity.canonical_id,
        score: anchorScore.score,
        signals: {
          ...anchorSignals,
          reason: opts.dryRun ? "dry_run_anchor_proximity_would_ask_llm" : "anchor_proximity_llm_disabled",
        },
        llmReason: null,
      };
    }
    return llmDecisionForCandidate(row, anchorProximity, anchorScore, anchorSignals);
  }

  if (
    !dateSignal.conflict &&
    score.score >= opts.tHigh &&
    score.signals.similarityFloorPassed &&
    !score.signals.coarseCoordinate
  ) {
    return {
      decision: "merge",
      method: "auto",
      candidatePoiId: best.canonical_id,
      score: score.score,
      signals: baseSignals,
      llmReason: null,
    };
  }

  if (dateSignal.conflict && (opts.noLlm || opts.dryRun) && score.score > opts.tLow) {
    return {
      decision: "new",
      method: "auto",
      candidatePoiId: best.canonical_id,
      score: score.score,
      signals: {
        ...baseSignals,
        reason: opts.dryRun ? "dry_run_date_conflict_would_ask_llm" : "date_conflict_llm_disabled",
      },
      llmReason: null,
    };
  }

  if (score.score <= opts.tLow) {
    return {
      decision: "new",
      method: "auto",
      candidatePoiId: best.canonical_id,
      score: score.score,
      signals: { ...baseSignals, reason: "below_low_threshold" },
      llmReason: null,
    };
  }

  if (
    !isAnchor(candidateAnchorMeta(best)) &&
    isSatelliteLikeResearch(row, score.signals.name)
  ) {
    return {
      decision: "new",
      method: "auto",
      candidatePoiId: best.canonical_id,
      score: score.score,
      signals: { ...baseSignals, reason: "satellite_pair_deferred_to_consolidation" },
      llmReason: null,
    };
  }

  if (opts.noLlm || opts.dryRun) {
    return {
      decision: "new",
      method: "auto",
      candidatePoiId: best.canonical_id,
      score: score.score,
      signals: {
        ...baseSignals,
        reason: opts.dryRun ? "dry_run_would_ask_llm" : "llm_disabled_gray_zone",
      },
      llmReason: null,
    };
  }

  return llmDecisionForCandidate(row, best, score, {
    ...baseSignals,
    match_context: best.via.includes("name")
      ? "same/similar name within wide location block; decide if coordinates diverge for one real-world place"
      : best.via.includes("proximity") && isAnchor(candidateAnchorMeta(best))
        ? "nearby same-category anchor/complex candidate"
        : "spatial candidate",
  });
}

async function createCanonical(client: PoolClient, row: ResearchMatchRow): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO canonical_pois (name, lng, lat, status, attributes, field_provenance, popularity)
     VALUES ($1, $2, $3, 'draft', '{}'::jsonb, '{}'::jsonb, 1)
     RETURNING id`,
    [row.name ?? row.name_normalized ?? row.id, row.lng, row.lat],
  );
  return rows[0]!.id;
}

async function writeDecision(
  client: PoolClient,
  rowId: string,
  decision: Decision,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO research_match_decisions
       (research_id, candidate_poi_id, score, signals, decision, method, llm_reason)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING id`,
    [
      rowId,
      decision.candidatePoiId,
      decision.score,
      JSON.stringify(decision.signals),
      decision.decision,
      decision.method,
      decision.llmReason,
    ],
  );
  return rows[0]!.id;
}

async function resetClusters(client: PoolClient): Promise<{ researchRows: number; canonicals: number }> {
  const canonicalCount = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM canonical_pois`,
  );
  const linkedCount = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM research_pois WHERE canonical_poi_id IS NOT NULL`,
  );
  await client.query(`DELETE FROM research_match_decisions`);
  await client.query(`UPDATE research_pois SET canonical_poi_id = NULL WHERE canonical_poi_id IS NOT NULL`);
  await client.query(`DELETE FROM canonical_pois`);
  return {
    researchRows: Number(linkedCount.rows[0]?.count ?? 0),
    canonicals: Number(canonicalCount.rows[0]?.count ?? 0),
  };
}

async function gcOrphanCanonicals(client: PoolClient, dryRun: boolean): Promise<number> {
  if (dryRun) {
    const { rows } = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM canonical_pois cp
       WHERE cp.status <> 'hidden'
         AND NOT EXISTS (
           SELECT 1 FROM research_pois rp WHERE rp.canonical_poi_id = cp.id
         )`,
    );
    return Number(rows[0]?.count ?? 0);
  }

  const { rowCount } = await client.query(
    `UPDATE canonical_pois cp
     SET status = 'hidden', updated_at = now()
     WHERE cp.status <> 'hidden'
       AND NOT EXISTS (
         SELECT 1 FROM research_pois rp WHERE rp.canonical_poi_id = cp.id
       )`,
  );
  return rowCount ?? 0;
}

async function applyDecision(
  client: PoolClient,
  row: ResearchMatchRow,
  decision: Decision,
  opts: CliOptions,
): Promise<string> {
  const canonicalId =
    decision.decision === "merge" && decision.candidatePoiId
      ? decision.candidatePoiId
      : await createCanonical(client, row);

  await collapseDuplicateCanonicals(client, canonicalId, decision.duplicateCanonicalIds ?? []);

  await client.query(
    `UPDATE research_pois SET
       canonical_poi_id = $2,
       matched_normalization_id = active_normalization_id
     WHERE id = $1`,
    [
    row.id,
    canonicalId,
    ],
  );
  const decisionId = await writeDecision(client, row.id, decision);
  await client.query(
    `UPDATE research_canonical_memberships
     SET active = false, retired_at = now(), retirement_reason = 'rematched'
     WHERE research_poi_id = $1 AND active`,
    [row.id],
  );
  await client.query(
    `INSERT INTO research_canonical_memberships (
       research_poi_id, normalization_id, canonical_poi_id,
       match_decision_id, matcher_version
     )
     SELECT id, active_normalization_id, $2, $3, $4
     FROM research_pois WHERE id = $1`,
    [row.id, canonicalId, decisionId, MATCHER_VERSION],
  );
  await rebuildCanonicalPoi(client, canonicalId, { noLlm: opts.noLlm });
  return canonicalId;
}

async function tryLock(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1) AS locked`,
    [ADVISORY_LOCK_ID],
  );
  return rows[0]?.locked === true;
}

function installShutdownHandler(signal: ShutdownSignal): () => void {
  const onSigint = () => {
    signal.count++;
    if (signal.count === 1) {
      signal.requested = true;
      console.warn("\nSIGINT received; stopping after the current row or consolidation group. Press Ctrl-C again to exit immediately.");
      return;
    }
    console.warn("\nSecond SIGINT received; exiting immediately.");
    process.exit(130);
  };

  process.on("SIGINT", onSigint);
  return () => process.off("SIGINT", onSigint);
}

async function runMatch(pool: Pool, opts: CliOptions, shutdown: ShutdownSignal): Promise<MatchStats> {
  const client = await pool.connect();
  const stats: MatchStats = {
    processed: 0,
    merged: 0,
    created: 0,
    llm: 0,
    auto: 0,
    strongId: 0,
    override: 0,
    proximity: 0,
    skipped: 0,
    garbageCollected: 0,
    consolidated: 0,
    stopped: false,
  };

  try {
    if (!(await tryLock(client))) {
      throw new Error("Another ingest:match process is already running.");
    }

    const snapshot = await loadMatchSnapshot(client, opts.source);
    printStartupBanner(opts, snapshot);

    if (opts.recluster) {
      await client.query("BEGIN");
      try {
        const reset = await resetClusters(client);
        await client.query("COMMIT");
        console.log(
          `Recluster reset: unlinked ${reset.researchRows} research rows and removed ${reset.canonicals} canonicals`,
        );
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    const sourceId = opts.source ? await resolveSourceId(client, opts.source) : null;
    const dryRunSeen = new Set<string>();
    while (!opts.consolidateOnly && !shutdown.requested && (opts.limit === undefined || stats.processed < opts.limit)) {
      await client.query("BEGIN");
      try {
        const row = await fetchNextRow(client, sourceId, opts.dryRun ? dryRunSeen : undefined);
        if (!row) {
          await client.query("COMMIT");
          break;
        }

        const decision = await decideRow(client, row, opts);
        if (opts.dryRun) {
          await client.query("ROLLBACK");
          dryRunSeen.add(row.id);
          console.log(
            `DRY ${row.name ?? row.id}: would ${decision.decision}` +
              `${decision.candidatePoiId ? ` ${decision.candidatePoiId}` : ""}` +
              ` (${decision.method}${decision.score !== null ? ` ${decision.score.toFixed(3)}` : ""})`,
          );
        } else {
          const canonicalId = await applyDecision(client, row, decision, opts);
          await client.query("COMMIT");
          console.log(
            `OK ${row.name ?? row.id}: ${decision.decision === "merge" ? "merged into" : "created"} ${canonicalId}` +
              ` (${decision.method}${decision.score !== null ? ` ${decision.score.toFixed(3)}` : ""})`,
          );
        }

        stats.processed++;
        if (decision.decision === "merge") stats.merged++;
        else stats.created++;
        if (decision.method === "llm") stats.llm++;
        if (decision.method === "auto") stats.auto++;
        if (decision.method === "strong_id") stats.strongId++;
        if (decision.method === "override") stats.override++;
        if (decision.method === "proximity") stats.proximity++;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    if (opts.consolidate && !shutdown.requested) {
      stats.consolidated = await runConsolidation(client, {
        dryRun: opts.dryRun,
        noLlm: opts.noLlm,
        shouldStop: () => shutdown.requested,
      });
    }

    if (opts.gcOrphans && !shutdown.requested) {
      await client.query("BEGIN");
      try {
        stats.garbageCollected = await gcOrphanCanonicals(client, opts.dryRun);
        if (opts.dryRun) {
          await client.query("ROLLBACK");
          console.log(`Orphan GC dry-run: would hide ${stats.garbageCollected} canonical POIs`);
        } else {
          await client.query("COMMIT");
          console.log(`Orphan GC: hid ${stats.garbageCollected} canonical POIs`);
        }
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1)`, [ADVISORY_LOCK_ID]);
    } catch {
      // Connection may already be closing; nothing useful to do.
    }
    client.release();
  }

  stats.stopped = shutdown.requested;
  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const shutdown: ShutdownSignal = { requested: false, count: 0 };
  const removeShutdownHandler = installShutdownHandler(shutdown);
  let stats: MatchStats | undefined;

  try {
    stats = await runMatch(db, opts, shutdown);

    if (stats.stopped) {
      const snapshot = await loadMatchSnapshot(db, opts.source);
      console.log(
        [
          "Stopped ingest:match.",
          `This run processed ${formatInt(stats.processed)} rows: merged=${formatInt(stats.merged)} created=${formatInt(stats.created)} llm=${formatInt(stats.llm)}.`,
          `Current database: linked=${formatInt(snapshot.linked)} pending=${formatInt(snapshot.pending)} canonicals=${formatInt(snapshot.canonicals)}.`,
          "Resume with:",
          `  ${resumeCommand(opts)}`,
        ].join("\n"),
      );
    }
  } finally {
    removeShutdownHandler();
    await db.end();
  }

  if (!stats) return;

  const mode = opts.dryRun ? " (dry-run)" : "";
  console.log(
    `Match${mode}${opts.consolidateOnly ? " consolidate-only" : ""}${opts.source ? ` ${opts.source}` : ""}: processed=${stats.processed} ` +
      `merged=${stats.merged} created=${stats.created} auto=${stats.auto} ` +
      `strong_id=${stats.strongId} proximity=${stats.proximity} llm=${stats.llm} override=${stats.override}` +
      `${opts.consolidate ? ` consolidated=${stats.consolidated}` : ""}` +
      `${opts.gcOrphans ? ` gc_orphans=${stats.garbageCollected}` : ""}`,
  );
}

main().catch((err) => {
  console.error("Match failed:", err);
  process.exit(1);
});
