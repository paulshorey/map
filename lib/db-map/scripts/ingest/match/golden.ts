/**
 * Golden-set evaluator for M8 matching.
 *
 * Uses labeled source/name pairs and reports precision/recall for the deterministic
 * scoring path. Pairs whose rows are not loaded yet are skipped, which lets the
 * fixture land before every garden source is available in a local database.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:match:golden
 */
import type { Pool } from "pg";
import { getDb } from "../../../lib/db/postgres.js";
import { ingestConfig } from "../config.js";
import { dateCompatibility } from "./dates.js";
import { haversineMeters } from "./geo.js";
import { extractStrongIds } from "./ids.js";
import { scoreCandidate } from "./score.js";

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
  name: string | null;
  name_normalized: string | null;
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
       rp.id, rp.source_record_id, rs.slug AS source_slug,
       rp.name, rp.name_normalized, rp.website_domain, rp.phone,
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

function predictSame(a: GoldenRow, b: GoldenRow): { same: boolean; score: number | null; reason: string } {
  if (sharesStrongId(a, b)) return { same: true, score: 1, reason: "strong_id" };
  const radiusM = Math.max(radiusFor(a.category_slugs), radiusFor(b.category_slugs));
  const distanceM = haversineMeters({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
  if (distanceM > radiusM) return { same: false, score: null, reason: "outside_radius" };

  const scored = scoreCandidate({
    current: a,
    candidate: b,
    distanceM,
    radiusM,
  });
  const dates = dateCompatibility({
    current: a,
    candidate: b,
    nameSimilarity: scored.signals.name,
    semanticSimilarity: scored.signals.semantic,
    localitySimilarity: scored.signals.locality,
    distanceM,
  });
  const same =
    !dates.conflict &&
    scored.score >= ingestConfig.match.tHigh &&
    scored.signals.similarityFloorPassed &&
    !scored.signals.coarseCoordinate;
  return { same, score: scored.score, reason: `score/${dates.reason}` };
}

async function main() {
  const db = getDb();
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let skipped = 0;

  for (const pair of DEFAULT_PAIRS) {
    const a = await findAnyRow(db, pair.a);
    const b = await findAnyRow(db, pair.b);
    if (!a || !b) {
      skipped++;
      console.warn(`Skipped - ${pair.note} (missing row)`);
      continue;
    }
    const predicted = predictSame(a, b);
    const expectedSame = pair.label === "same";
    if (predicted.same && expectedSame) tp++;
    else if (predicted.same && !expectedSame) fp++;
    else if (!predicted.same && expectedSame) fn++;
    else tn++;
    console.log(
      `${predicted.same === expectedSame ? "OK" : "FAIL"} ${pair.note}: expected=${pair.label} ` +
        `predicted=${predicted.same ? "same" : "different"} ` +
        `score=${predicted.score === null ? "n/a" : predicted.score.toFixed(3)} reason=${predicted.reason}`,
    );
  }

  await db.end();
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  console.log(
    `Golden: evaluated=${tp + fp + tn + fn} skipped=${skipped} ` +
      `tp=${tp} fp=${fp} tn=${tn} fn=${fn} ` +
      `precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`,
  );
}

main().catch((err) => {
  console.error("Golden match evaluation failed:", err);
  process.exit(1);
});
