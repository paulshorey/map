/**
 * Match research_pois into canonical_pois (M8).
 *
 * Resumable loop over rows where canonical_poi_id IS NULL and coordinates exist.
 * Each row is processed in its own transaction: decide merge/new, audit the decision,
 * attach/create a canonical POI, then rebuild that canonical from linked research rows.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:match [--source <slug>] [--limit N] [--dry-run] [--no-llm]
 *   pnpm --filter @lib/db-map ingest:match --recluster
 *   pnpm --filter @lib/db-map ingest:match --gc-orphans
 */
import type { Pool, PoolClient } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { ingestConfig } from "./config.js";
import { rebuildCanonicalPoi } from "./merge.js";
import { dateCompatibility, type DateCompatibilitySignal } from "./match/dates.js";
import { bboxAround, haversineMeters } from "./match/geo.js";
import { extractStrongIds } from "./match/ids.js";
import { adjudicateMatch } from "./match/llm.js";
import { scoreCandidate, type CandidateScore } from "./match/score.js";

const ADVISORY_LOCK_ID = 0x5018a;
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
  skipped: number;
  garbageCollected: number;
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
  canonical_starts_at: Date | null;
  canonical_ends_at: Date | null;
  canonical_date_precision: string | null;
  best_research_id: string | null;
  best_name: string | null;
  best_name_normalized: string | null;
  best_content_embedding: number[] | null;
  best_website_domain: string | null;
  best_phone: string | null;
  best_city: string | null;
  best_region: string | null;
  best_country_code: string | null;
  best_coordinate_precision: string | null;
  best_starts_at: Date | null;
  best_ends_at: Date | null;
  best_date_precision: string | null;
  distance_m: number;
  score?: CandidateScore;
  dateCompatibility?: DateCompatibilitySignal;
}

interface Decision {
  decision: "merge" | "new";
  method: "strong_id" | "auto" | "llm" | "override";
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
  return { source, limit, dryRun, noLlm, recluster, gcOrphans, tHigh, tLow };
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
  const { rows } = await client.query<Omit<CandidateRow, "distance_m">>(
    `SELECT
       cp.id AS canonical_id,
       cp.name AS canonical_name,
       cp.lat AS canonical_lat,
       cp.lng AS canonical_lng,
       cp.website AS canonical_website,
       cp.phone AS canonical_phone,
       cp.starts_at AS canonical_starts_at,
       cp.ends_at AS canonical_ends_at,
       cp.date_precision AS canonical_date_precision,
       br.id AS best_research_id,
       br.name AS best_name,
       br.name_normalized AS best_name_normalized,
       br.content_embedding AS best_content_embedding,
       br.website_domain AS best_website_domain,
       br.phone AS best_phone,
       br.city AS best_city,
       br.region AS best_region,
       br.country_code AS best_country_code,
       br.coordinate_precision AS best_coordinate_precision,
       br.starts_at AS best_starts_at,
       br.ends_at AS best_ends_at,
       br.date_precision AS best_date_precision
     FROM canonical_pois cp
     LEFT JOIN LATERAL (
       SELECT rp.*, rs.trust
       FROM research_pois rp
       JOIN research_sources rs ON rs.id = rp.source_id
       WHERE rp.canonical_poi_id = cp.id AND rp.is_poi
       ORDER BY rs.trust DESC, (rp.content_embedding IS NOT NULL) DESC, rp.last_seen_at DESC
       LIMIT 1
     ) br ON true
     WHERE cp.status <> 'hidden'
       AND cp.lat BETWEEN $1 AND $2
       AND cp.lng BETWEEN $3 AND $4
     LIMIT 100`,
    [bbox.minLat, bbox.maxLat, bbox.minLng, bbox.maxLng],
  );

  return rows
    .filter((candidate) => !excluded.has(candidate.canonical_id))
    .map((candidate) => ({
      ...candidate,
      distance_m: haversineMeters(
        { lat: row.lat, lng: row.lng },
        { lat: candidate.canonical_lat, lng: candidate.canonical_lng },
      ),
    }))
    .filter((candidate) => candidate.distance_m <= radiusM)
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, 25);
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

  const candidates = scoreCandidates(
    row,
    await fetchCandidates(client, row, overrides.forceDifferentCanonicalIds),
  );

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
    date_compatibility: dateSignal,
    signals: score.signals,
  };

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

  const llm = await adjudicateMatch({
    current: {
      name: row.name,
      address: row.address,
      city: row.city,
      region: row.region,
      country_code: row.country_code,
      website: row.website,
      phone: row.phone,
      categories: row.category_slugs,
      coordinate_precision: row.coordinate_precision,
      starts_at: row.starts_at,
      ends_at: row.ends_at,
      date_precision: row.date_precision,
    },
    candidate: {
      name: best.best_name ?? best.canonical_name,
      canonical_name: best.canonical_name,
      city: best.best_city,
      region: best.best_region,
      country_code: best.best_country_code,
      website: best.best_website_domain ?? best.canonical_website,
      phone: best.best_phone ?? best.canonical_phone,
      coordinate_precision: best.best_coordinate_precision,
      starts_at: best.best_starts_at ?? best.canonical_starts_at,
      ends_at: best.best_ends_at ?? best.canonical_ends_at,
      date_precision: best.best_date_precision ?? best.canonical_date_precision,
    },
    distance_m: Math.round(best.distance_m),
    score: score.score,
    signals: baseSignals,
  });

  return {
    decision: llm.samePlace ? "merge" : "new",
    method: "llm",
    candidatePoiId: best.canonical_id,
    score: score.score,
    signals: baseSignals,
    llmReason: llm.reason,
  };
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

async function collapseDuplicateCanonicals(
  client: PoolClient,
  targetId: string,
  duplicateIds: string[],
): Promise<void> {
  if (duplicateIds.length === 0) return;
  await client.query(
    `UPDATE research_pois SET canonical_poi_id = $1 WHERE canonical_poi_id = ANY($2)`,
    [targetId, duplicateIds],
  );
  await client.query(
    `UPDATE canonical_pois SET status = 'hidden', updated_at = now() WHERE id = ANY($1)`,
    [duplicateIds],
  );
}

async function writeDecision(
  client: PoolClient,
  rowId: string,
  decision: Decision,
): Promise<void> {
  await client.query(
    `INSERT INTO research_match_decisions
       (research_id, candidate_poi_id, score, signals, decision, method, llm_reason)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
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

  await client.query(`UPDATE research_pois SET canonical_poi_id = $2 WHERE id = $1`, [
    row.id,
    canonicalId,
  ]);
  await writeDecision(client, row.id, decision);
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

async function runMatch(pool: Pool, opts: CliOptions): Promise<MatchStats> {
  const client = await pool.connect();
  const stats: MatchStats = {
    processed: 0,
    merged: 0,
    created: 0,
    llm: 0,
    auto: 0,
    strongId: 0,
    override: 0,
    skipped: 0,
    garbageCollected: 0,
  };

  try {
    if (!(await tryLock(client))) {
      throw new Error("Another ingest:match process is already running.");
    }

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
    while (opts.limit === undefined || stats.processed < opts.limit) {
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
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    if (opts.gcOrphans) {
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

  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const stats = await runMatch(db, opts);
  await db.end();

  const mode = opts.dryRun ? " (dry-run)" : "";
  console.log(
    `Match${mode}${opts.source ? ` ${opts.source}` : ""}: processed=${stats.processed} ` +
      `merged=${stats.merged} created=${stats.created} auto=${stats.auto} ` +
      `strong_id=${stats.strongId} llm=${stats.llm} override=${stats.override}` +
      `${opts.gcOrphans ? ` gc_orphans=${stats.garbageCollected}` : ""}`,
  );
}

main().catch((err) => {
  console.error("Match failed:", err);
  process.exit(1);
});
