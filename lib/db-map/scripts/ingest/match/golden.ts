/**
 * Golden-set evaluator for M8 matching.
 *
 * Labeled source/name pairs are run through the SAME decision routing as the real
 * matcher (match.ts): strong-id → spatial block → score → auto-merge / gray-zone → LLM
 * / auto-new. Reports precision/recall over the final decisions.
 *
 * A "same" pair is a single real place duplicated across sources (e.g. Kew appears in
 * wikidata, bgci, and osm) — those should collapse into one canonical. A "different"
 * pair is two distinct places; they must never merge. Far-apart places are rejected on
 * distance BEFORE any scoring/embedding/LLM (proximity is a hard precondition).
 *
 * The gray zone (T_low < score < T_high, or a similarity/coordinate guard blocked
 * auto-merge) is adjudicated by the LLM, mirroring the pipeline. Pass --no-llm to skip
 * the LLM and report gray-zone pairs as "deferred" (excluded from precision/recall)
 * instead of guessing.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:match:golden [--no-llm]
 */
import type { Pool } from "pg";
import { getDb } from "../../../lib/db/postgres.js";
import { ingestConfig } from "../config.js";
import {
  distinctiveName,
  isSatelliteLikeResearch,
  isWithinProximityBox,
  normalizedExactName,
} from "./anchors.js";
import { dateCompatibility } from "./dates.js";
import { haversineMeters } from "./geo.js";
import { extractStrongIds } from "./ids.js";
import { adjudicateMatch } from "./llm.js";
import { scoreCandidate } from "./score.js";
import { nameSimilarity } from "./text.js";

interface GoldenRef {
  source?: string;
  name: string;
}

type GoldenRefInput = GoldenRef | GoldenRef[];

interface GoldenPair {
  label: "same" | "different";
  note: string;
  a: GoldenRefInput;
  b: GoldenRefInput;
}

interface GoldenRow {
  id: string;
  source_record_id: string;
  source_slug: string;
  source_trust: number;
  name: string | null;
  name_normalized: string | null;
  website: string | null;
  website_domain: string | null;
  phone: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  lat: number;
  lng: number;
  starts_at: Date | null;
  ends_at: Date | null;
  date_precision: string | null;
  category_slugs: string[] | null;
  content_embedding: number[] | null;
  coordinate_precision: string | null;
  attributes: Record<string, unknown> | null;
  raw: unknown;
}

const DEFAULT_PAIRS: GoldenPair[] = [
  {
    label: "same",
    note: "Kew should merge across open datasets",
    a: { source: "wikidata", name: "Kew Gardens" },
    b: [
      { source: "osm", name: "Royal Botanic Gardens, Kew" },
      { source: "bgci", name: "Royal Botanic Gardens, Kew" },
    ],
  },
  {
    label: "same",
    note: "Missouri Botanical Garden cross-source duplicate",
    a: { source: "wikidata", name: "Missouri Botanical Garden" },
    b: [
      { source: "osm", name: "Missouri Botanical Garden" },
      { source: "bgci", name: "Missouri Botanical Garden" },
    ],
  },
  {
    label: "same",
    note: "New York Botanical Garden cross-source duplicate",
    a: { source: "wikidata", name: "New York Botanical Garden" },
    b: [
      { source: "osm", name: "New York Botanical Garden" },
      { source: "bgci", name: "The New York Botanical Garden" },
    ],
  },
  {
    label: "same",
    note: "Houston Botanic Garden same-name divergent coordinates",
    a: { source: "bgci", name: "Houston Botanic Garden" },
    b: [
      { source: "wikidata", name: "Houston Botanic Garden" },
      { source: "osm", name: "Houston Botanic Garden" },
    ],
  },
  {
    label: "same",
    note: "Talbot same-name near duplicate",
    a: { name: "Talbot Botanic Garden" },
    b: { name: "Talbot Botanic Garden" },
  },
  {
    label: "same",
    note: "Queens sub-garden should merge into Queens Botanical Garden",
    a: { name: "Queens Botanical Garden" },
    b: { source: "osm", name: "Arboretum/Crabapple Grove" },
  },
  {
    label: "same",
    note: "Dallas sub-garden should merge into Dallas Arboretum",
    a: { name: "Dallas Arboretum" },
    b: { name: "A Woman's Garden" },
  },
  {
    label: "different",
    note: "Kew and Chelsea Physic Garden are different London gardens",
    a: { name: "Royal Botanic Gardens, Kew" },
    b: { name: "Chelsea Physic Garden" },
  },
  {
    label: "different",
    note: "Missouri Botanical Garden and New York Botanical Garden are different",
    a: { name: "Missouri Botanical Garden" },
    b: { name: "New York Botanical Garden" },
  },
  {
    label: "same",
    note: "Tomorrowland editions should collapse to one festival canonical",
    a: { name: "Tomorrowland" },
    b: { name: "Tomorrowland 2026" },
  },
  {
    label: "same",
    note: "New Orleans Jazz & Heritage Festival editions should collapse",
    a: { name: "New Orleans Jazz & Heritage Festival" },
    b: { name: "New Orleans Jazz & Heritage Festival 2026" },
  },
  {
    label: "different",
    note: "Same-city festival centroids with different names should not merge",
    a: { name: "SXSW" },
    b: { name: "Austin City Limits" },
  },
  {
    label: "different",
    note: "Miami city-centroid music events should remain distinct",
    a: { name: "Ultra Music Festival" },
    b: { name: "Miami Music Week" },
  },
];

function radiusFor(slugs: string[] | null): number {
  if (slugs?.some((slug) => slug === "botanical_garden" || slug === "arboretum" || slug === "gardens")) {
    return 600;
  }
  if (slugs?.some((slug) => slug === "music_festival" || slug === "carnival")) {
    return 1_000;
  }
  if (slugs?.some((slug) => slug === "art_fair" || slug === "art_parade")) {
    return 800;
  }
  return 300;
}

async function findRow(db: Pool, ref: GoldenRef): Promise<GoldenRow | null> {
  const params: unknown[] = [`%${ref.name}%`];
  let sourceJoin = "";
  if (ref.source) {
    params.push(ref.source);
    sourceJoin = `AND rs.slug = $${params.length}`;
  }
  const { rows } = await db.query<GoldenRow>(
    `SELECT
       rp.id, rp.source_record_id, rs.slug AS source_slug, rs.trust AS source_trust,
       rp.name, rp.name_normalized, rp.website, rp.website_domain, rp.phone,
       rp.city, rp.region, rp.country_code, rp.lat, rp.lng,
       rp.starts_at, rp.ends_at, rp.date_precision,
       rp.category_slugs, rp.content_embedding, rp.coordinate_precision,
       rp.attributes, rp.raw
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE rp.is_poi
       AND rp.lat IS NOT NULL
       AND rp.lng IS NOT NULL
       AND rp.name ILIKE $1
       ${sourceJoin}
     ORDER BY rs.trust DESC, rp.name
     LIMIT 1`,
    params,
  );
  return rows[0] ?? null;
}

async function findAnyRow(db: Pool, refs: GoldenRefInput): Promise<GoldenRow | null> {
  for (const ref of Array.isArray(refs) ? refs : [refs]) {
    const row = await findRow(db, ref);
    if (row) return row;
  }
  return null;
}

function sharesStrongId(a: GoldenRow, b: GoldenRow): boolean {
  const aa = extractStrongIds(a);
  const bb = extractStrongIds(b);
  return (
    aa.wikidata.some((id) => bb.wikidata.includes(id)) ||
    aa.osm.some((id) => bb.osm.includes(id))
  );
}

function sameCategory(a: GoldenRow, b: GoldenRow): boolean {
  const bb = new Set(b.category_slugs ?? []);
  return (a.category_slugs ?? []).some((slug) => bb.has(slug));
}

function anchorLike(row: GoldenRow): boolean {
  return row.source_trust >= 80 || Boolean(row.website);
}

const T_HIGH = ingestConfig.match.tHigh;
const T_LOW = ingestConfig.match.tLow;

type DecisionMethod =
  | "strong_id"
  | "auto"
  | "llm"
  | "llm_error"
  | "gray_zone_deferred";

interface FinalDecision {
  decision: "merge" | "new";
  method: DecisionMethod;
  score: number | null;
  reason: string;
}

/**
 * Resolve a pair using the same routing as the live matcher. Distance is a hard gate:
 * pairs outside the category radius return `new` immediately, never scored/embedded/LLM'd.
 */
async function resolveDecision(a: GoldenRow, b: GoldenRow, useLlm: boolean): Promise<FinalDecision> {
  if (sharesStrongId(a, b)) {
    return { decision: "merge", method: "strong_id", score: 1, reason: "strong_id" };
  }

  const radiusM = Math.max(radiusFor(a.category_slugs), radiusFor(b.category_slugs));
  const distanceM = haversineMeters({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
  const exactName = normalizedExactName(a.name_normalized ?? a.name, b.name_normalized ?? b.name);
  const proximity = sameCategory(a, b) && isWithinProximityBox(a, b, a.category_slugs);
  const fastPathDates = dateCompatibility({
    current: a,
    candidate: b,
    nameSimilarity: exactName ? 1 : 0,
    semanticSimilarity: exactName ? 1 : 0,
    localitySimilarity: 0,
    distanceM,
  });

  if (proximity && exactName && !fastPathDates.conflict) {
    return { decision: "merge", method: "auto", score: 1, reason: "exact_name_proximity" };
  }

  if (proximity && !fastPathDates.conflict) {
    const similarity = nameSimilarity(a.name_normalized ?? a.name, b.name_normalized ?? b.name);
    const aSatellite = isSatelliteLikeResearch(a, similarity);
    const bSatellite = isSatelliteLikeResearch(b, similarity);
    if ((aSatellite && anchorLike(b)) || (bSatellite && anchorLike(a))) {
      return { decision: "merge", method: "auto", score: null, reason: "satellite_anchor_proximity" };
    }
  }

  if (
    distanceM <= ingestConfig.match.nameBlockKm * 1000 &&
    sameCategory(a, b) &&
    exactName &&
    distinctiveName(a.name_normalized ?? a.name) &&
    !fastPathDates.conflict
  ) {
    return { decision: "merge", method: "auto", score: 1, reason: "distinctive_exact_name_name_block" };
  }

  if (distanceM > radiusM) {
    return { decision: "new", method: "auto", score: null, reason: "outside_radius" };
  }

  const scored = scoreCandidate({ current: a, candidate: b, distanceM, radiusM });
  const dates = dateCompatibility({
    current: a,
    candidate: b,
    nameSimilarity: scored.signals.name,
    semanticSimilarity: scored.signals.semantic,
    localitySimilarity: scored.signals.locality,
    distanceM,
  });

  const autoMerge =
    !dates.conflict &&
    scored.score >= T_HIGH &&
    scored.signals.similarityFloorPassed &&
    !scored.signals.coarseCoordinate;
  if (autoMerge) {
    return { decision: "merge", method: "auto", score: scored.score, reason: `auto_merge/${dates.reason}` };
  }

  if (scored.score <= T_LOW) {
    return { decision: "new", method: "auto", score: scored.score, reason: `below_low/${dates.reason}` };
  }

  // Gray zone — match.ts routes this to the LLM adjudicator.
  if (!useLlm) {
    return {
      decision: "new",
      method: "gray_zone_deferred",
      score: scored.score,
      reason: `gray_zone_deferred/${dates.reason}`,
    };
  }

  const llmRecord = (row: GoldenRow) => ({
    name: row.name,
    city: row.city,
    region: row.region,
    country_code: row.country_code,
    website: row.website_domain,
    phone: row.phone,
    categories: row.category_slugs,
    coordinate_precision: row.coordinate_precision,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    date_precision: row.date_precision,
  });

  try {
    const llm = await adjudicateMatch({
      current: llmRecord(a),
      candidate: llmRecord(b),
      distance_m: Math.round(distanceM),
      score: scored.score,
      signals: scored.signals,
    });
    return {
      decision: llm.samePlace ? "merge" : "new",
      method: "llm",
      score: scored.score,
      reason: `llm_${llm.samePlace ? "merge" : "new"}`,
    };
  } catch (err) {
    // Conservative fallback mirrors match.ts: an LLM/API failure never auto-merges.
    return {
      decision: "new",
      method: "llm_error",
      score: scored.score,
      reason: `llm_error: ${(err as Error).message}`,
    };
  }
}

interface CliOptions {
  useLlm: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  let useLlm = true;
  for (const a of argv) {
    if (a === "--no-llm") useLlm = false;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { useLlm };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let deferred = 0;
  let skipped = 0;
  const methodCounts: Record<string, number> = {};

  for (const pair of DEFAULT_PAIRS) {
    const a = await findAnyRow(db, pair.a);
    const b = await findAnyRow(db, pair.b);
    if (!a || !b) {
      skipped++;
      console.warn(`Skipped - ${pair.note} (missing row)`);
      continue;
    }

    const result = await resolveDecision(a, b, opts.useLlm);
    methodCounts[result.method] = (methodCounts[result.method] ?? 0) + 1;
    const expectedSame = pair.label === "same";

    let verdict: "OK" | "FAIL" | "DEFER";
    if (result.method === "gray_zone_deferred") {
      deferred++;
      verdict = "DEFER";
    } else if (result.decision === "merge" && expectedSame) {
      tp++;
      verdict = "OK";
    } else if (result.decision === "merge" && !expectedSame) {
      fp++;
      verdict = "FAIL";
    } else if (result.decision === "new" && expectedSame) {
      fn++;
      verdict = "FAIL";
    } else {
      tn++;
      verdict = "OK";
    }

    console.log(
      `${verdict} ${pair.note}: expected=${pair.label} decision=${result.decision} ` +
        `method=${result.method} score=${result.score === null ? "n/a" : result.score.toFixed(3)} ` +
        `reason=${result.reason}`,
    );
  }

  await db.end();
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  console.log(
    `Golden: evaluated=${tp + fp + tn + fn} deferred=${deferred} skipped=${skipped} ` +
      `tp=${tp} fp=${fp} tn=${tn} fn=${fn} ` +
      `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`,
  );
  console.log(
    `Methods: ${Object.entries(methodCounts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") || "none"}`,
  );

  // A false positive means two genuinely different places were merged — the cardinal
  // sin for de-duplication. Fail the gate so it can't slip through.
  if (fp > 0) {
    console.error(`Golden gate FAILED: ${fp} different-place pair(s) were merged (false positive).`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Golden match evaluation failed:", err);
  process.exit(1);
});
