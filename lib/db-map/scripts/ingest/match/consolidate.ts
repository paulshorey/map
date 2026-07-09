import type { PoolClient } from "pg";
import { rebuildCanonicalPoi } from "../merge.js";
import {
  canonicalAnchorSort,
  isAnchor,
  isWithinProximityBox,
  pairDistanceM,
  proximityDegFor,
  type AnchorMeta,
} from "./anchors.js";
import { collapseDuplicateCanonicals } from "./canonicals.js";
import { adjudicateMatch } from "./llm.js";

interface ConsolidateOptions {
  dryRun: boolean;
  noLlm: boolean;
  shouldStop?: () => boolean;
}

interface CanonicalRow extends AnchorMeta {
  id: string;
  name: string;
  description: string | null;
  lat: number;
  lng: number;
  website: string | null;
  phone: string | null;
  address: string | null;
  primary_slug: string | null;
  category_slugs: string[];
  updated_at: Date;
}

interface MemoVerdict {
  same_place: boolean;
  reason: string | null;
}

interface MergePlan {
  targetId: string;
  duplicateId: string;
  reason: string;
  distanceM: number;
}

function meta(row: CanonicalRow): AnchorMeta {
  return {
    canonical_id: row.id,
    popularity: row.popularity,
    max_source_trust: row.max_source_trust,
    has_website: row.has_website,
    has_wikidata_qid: row.has_wikidata_qid,
  };
}

function categoryKey(row: CanonicalRow): string | null {
  return row.primary_slug ?? row.category_slugs[0] ?? null;
}

function sameCategorySlugs(a: CanonicalRow, b: CanonicalRow): string[] {
  const bb = new Set(b.category_slugs);
  return a.category_slugs.filter((slug) => bb.has(slug));
}

function withinProximity(a: CanonicalRow, b: CanonicalRow): boolean {
  const slugs = sameCategorySlugs(a, b);
  if (slugs.length === 0) return false;
  return proximityDegFor(slugs) > 0 && isWithinProximityBox(a, b, slugs);
}

function strongerFirst(a: CanonicalRow, b: CanonicalRow): number {
  return canonicalAnchorSort(meta(a), meta(b));
}

function medoid(rows: CanonicalRow[]): CanonicalRow {
  return [...rows].sort((a, b) => {
    const aSum = rows.reduce((sum, row) => sum + pairDistanceM(a, row), 0);
    const bSum = rows.reduce((sum, row) => sum + pairDistanceM(b, row), 0);
    return aSum - bSum || strongerFirst(a, b);
  })[0]!;
}

function bucketKey(lat: number, lng: number, deg: number): string {
  return `${Math.floor(lat / deg)}:${Math.floor(lng / deg)}`;
}

function buildIndex(rows: CanonicalRow[], deg: number): Map<string, CanonicalRow[]> {
  const index = new Map<string, CanonicalRow[]>();
  for (const row of rows) {
    const key = bucketKey(row.lat, row.lng, deg);
    index.set(key, [...(index.get(key) ?? []), row]);
  }
  return index;
}

function nearbyRows(index: Map<string, CanonicalRow[]>, row: CanonicalRow, deg: number): CanonicalRow[] {
  const latBucket = Math.floor(row.lat / deg);
  const lngBucket = Math.floor(row.lng / deg);
  const rows: CanonicalRow[] = [];
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLng = -1; dLng <= 1; dLng++) {
      rows.push(...(index.get(`${latBucket + dLat}:${lngBucket + dLng}`) ?? []));
    }
  }
  return rows;
}

async function loadCanonicals(client: PoolClient): Promise<CanonicalRow[]> {
  const { rows } = await client.query<CanonicalRow>(
    `SELECT
       cp.id,
       cp.name,
       cp.description,
       cp.lat,
       cp.lng,
       cp.website,
       cp.phone,
       cp.address,
       cp.updated_at,
       cp.popularity,
       primary_cat.slug AS primary_slug,
       COALESCE(array_remove(array_agg(DISTINCT cc.slug), NULL), ARRAY[]::text[]) AS category_slugs,
       COALESCE(max(rs.trust), 0)::int AS max_source_trust,
       COALESCE(bool_or(rp.website IS NOT NULL OR cp.website IS NOT NULL), cp.website IS NOT NULL) AS has_website,
       COALESCE(bool_or(
         rp.attributes->>'wikidata_id' IS NOT NULL
         OR rp.attributes->>'wikidata' IS NOT NULL
         OR rp.raw->>'wikidata_id' IS NOT NULL
         OR rp.raw->>'wikidata' IS NOT NULL
         OR rp.source_record_id ~* '^Q[0-9]+$'
       ), false) AS has_wikidata_qid
     FROM canonical_pois cp
     LEFT JOIN canonical_categories primary_cat ON primary_cat.id = cp.primary_category_id
     LEFT JOIN canonical_poi_categories cpc ON cpc.poi_id = cp.id
     LEFT JOIN canonical_categories cc ON cc.id = cpc.category_id
     LEFT JOIN research_pois rp ON rp.canonical_poi_id = cp.id AND rp.is_poi
     LEFT JOIN research_sources rs ON rs.id = rp.source_id
     WHERE cp.status <> 'hidden'
     GROUP BY cp.id, primary_cat.slug
     ORDER BY cp.popularity DESC, cp.id`,
  );
  return rows.filter((row) => row.category_slugs.length > 0);
}

function addPlan(plans: Map<string, MergePlan>, plan: MergePlan): void {
  if (plan.targetId === plan.duplicateId || plans.has(plan.duplicateId)) return;
  plans.set(plan.duplicateId, plan);
}

function orderedPair(a: CanonicalRow, b: CanonicalRow): [CanonicalRow, CanonicalRow] {
  return a.id < b.id ? [a, b] : [b, a];
}

/**
 * Read a memoized anchor-anchor verdict. Returns null when there is no verdict or
 * when either canonical changed after the verdict (stale → re-adjudicate).
 */
async function readConsolidationMemo(
  client: PoolClient,
  a: CanonicalRow,
  b: CanonicalRow,
): Promise<MemoVerdict | null> {
  const [lo, hi] = orderedPair(a, b);
  const { rows } = await client.query<MemoVerdict & { decided_at: Date }>(
    `SELECT same_place, reason, decided_at
     FROM research_consolidation_decisions
     WHERE canonical_a = $1 AND canonical_b = $2`,
    [lo.id, hi.id],
  );
  const memo = rows[0];
  if (!memo) return null;
  const decidedAt = new Date(memo.decided_at).getTime();
  if (
    decidedAt < new Date(lo.updated_at).getTime() ||
    decidedAt < new Date(hi.updated_at).getTime()
  ) {
    return null;
  }
  return { same_place: memo.same_place, reason: memo.reason };
}

async function writeConsolidationMemo(
  client: PoolClient,
  a: CanonicalRow,
  b: CanonicalRow,
  verdict: MemoVerdict,
): Promise<void> {
  const [lo, hi] = orderedPair(a, b);
  await client.query(
    `INSERT INTO research_consolidation_decisions (canonical_a, canonical_b, same_place, reason, method)
     VALUES ($1, $2, $3, $4, 'llm')
     ON CONFLICT (canonical_a, canonical_b)
     DO UPDATE SET same_place = EXCLUDED.same_place, reason = EXCLUDED.reason,
                   method = EXCLUDED.method, decided_at = now()`,
    [lo.id, hi.id, verdict.same_place, verdict.reason],
  );
}

async function planAnchorAnchorMerges(
  client: PoolClient,
  rows: CanonicalRow[],
  plans: Map<string, MergePlan>,
  opts: ConsolidateOptions,
): Promise<void> {
  const anchors = rows.filter((row) => isAnchor(meta(row))).sort(strongerFirst);
  for (let i = 0; i < anchors.length; i++) {
    if (opts.shouldStop?.()) return;
    const a = anchors[i]!;
    if (plans.has(a.id)) continue;
    for (let j = i + 1; j < anchors.length; j++) {
      if (opts.shouldStop?.()) return;
      const b = anchors[j]!;
      if (plans.has(b.id) || !withinProximity(a, b)) continue;
      const distanceM = pairDistanceM(a, b);

      // Memoized verdicts survive reruns: "different place" pairs are skipped
      // without an LLM call until either canonical is rebuilt with new data.
      const memo = await readConsolidationMemo(client, a, b);
      if (memo) {
        if (!memo.same_place) continue;
        const ordered = [a, b].sort(strongerFirst);
        addPlan(plans, {
          targetId: ordered[0]!.id,
          duplicateId: ordered[1]!.id,
          reason: `anchor_anchor_memo:${memo.reason ?? "previously adjudicated same place"}`,
          distanceM,
        });
        continue;
      }

      if (opts.noLlm || opts.dryRun) {
        continue;
      }

      const llm = await adjudicateMatch({
        current: {
          name: a.name,
          description: a.description,
          address: a.address,
          website: a.website,
          phone: a.phone,
          lat: a.lat,
          lng: a.lng,
          categories: a.category_slugs,
        },
        candidate: {
          name: b.name,
          description: b.description,
          address: b.address,
          website: b.website,
          phone: b.phone,
          lat: b.lat,
          lng: b.lng,
          categories: b.category_slugs,
        },
        distance_m: Math.round(distanceM),
        score: 0,
        signals: {
          reason: "anchor_anchor_proximity_consolidation",
          proximity_deg: proximityDegFor(sameCategorySlugs(a, b)),
          guidance: "Decide whether these are one real-world place or one visitor complex despite different names.",
        },
      });

      await writeConsolidationMemo(client, a, b, {
        same_place: llm.samePlace,
        reason: llm.reason,
      });
      console.log(
        `Anchor-anchor LLM verdict: ${a.name} / ${b.name} → ${llm.samePlace ? "same" : "different"} (${llm.reason})`,
      );

      if (!llm.samePlace) continue;
      const ordered = [a, b].sort(strongerFirst);
      const target = ordered[0]!;
      const duplicate = ordered[1]!;
      addPlan(plans, {
        targetId: target.id,
        duplicateId: duplicate.id,
        reason: `anchor_anchor_llm:${llm.reason}`,
        distanceM,
      });
    }
  }
}

async function planMerges(
  client: PoolClient,
  opts: ConsolidateOptions,
): Promise<MergePlan[]> {
  const rows = await loadCanonicals(client);
  const plans = new Map<string, MergePlan>();
  const groups = new Map<string, CanonicalRow[]>();
  for (const row of rows) {
    const key = categoryKey(row);
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  for (const groupRows of groups.values()) {
    if (opts.shouldStop?.()) break;
    const key = categoryKey(groupRows[0]!);
    const deg = proximityDegFor(key ? [key] : groupRows[0]!.category_slugs);
    if (deg <= 0) continue;

    const anchors = groupRows.filter((row) => isAnchor(meta(row))).sort(strongerFirst);
    const satellites = groupRows.filter((row) => !isAnchor(meta(row))).sort(strongerFirst);
    const anchorIndex = buildIndex(anchors, deg);

    for (const satellite of satellites) {
      if (opts.shouldStop?.()) break;
      const anchor = nearbyRows(anchorIndex, satellite, deg)
        .filter((candidate) => withinProximity(satellite, candidate))
        .sort((a, b) => strongerFirst(a, b) || pairDistanceM(satellite, a) - pairDistanceM(satellite, b))[0];
      if (!anchor) continue;
      addPlan(plans, {
        targetId: anchor.id,
        duplicateId: satellite.id,
        reason: "satellite_anchor_proximity",
        distanceM: pairDistanceM(satellite, anchor),
      });
    }

    const satelliteIndex = buildIndex(satellites, deg);
    const remaining = new Set(satellites.filter((row) => !plans.has(row.id)).map((row) => row.id));
    for (const seed of satellites) {
      if (opts.shouldStop?.()) break;
      if (!remaining.has(seed.id)) continue;
      const seedCluster = nearbyRows(satelliteIndex, seed, deg)
        .filter((row) => remaining.has(row.id) && withinProximity(seed, row));
      if (seedCluster.length <= 1) {
        remaining.delete(seed.id);
        continue;
      }

      const leader = medoid(seedCluster);
      const cluster = nearbyRows(satelliteIndex, leader, deg)
        .filter((row) => remaining.has(row.id) && withinProximity(leader, row));
      if (cluster.length <= 1) {
        remaining.delete(seed.id);
        continue;
      }

      for (const duplicate of cluster) {
        if (duplicate.id === leader.id) continue;
        addPlan(plans, {
          targetId: leader.id,
          duplicateId: duplicate.id,
          reason: "satellite_leader_cluster",
          distanceM: pairDistanceM(leader, duplicate),
        });
      }
      for (const member of cluster) remaining.delete(member.id);
    }

    // Always runs so memoized verdicts apply even in --dry-run / --no-llm modes;
    // fresh LLM adjudication only happens in real LLM-enabled runs.
    await planAnchorAnchorMerges(client, groupRows, plans, opts);
  }

  return [...plans.values()].sort((a, b) => a.targetId.localeCompare(b.targetId) || a.duplicateId.localeCompare(b.duplicateId));
}

async function applyPlans(client: PoolClient, plans: MergePlan[], opts: ConsolidateOptions): Promise<void> {
  const byTarget = new Map<string, MergePlan[]>();
  for (const plan of plans) byTarget.set(plan.targetId, [...(byTarget.get(plan.targetId) ?? []), plan]);

  for (const [targetId, targetPlans] of byTarget) {
    if (opts.shouldStop?.()) break;
    await client.query("BEGIN");
    try {
      await collapseDuplicateCanonicals(
        client,
        targetId,
        targetPlans.map((plan) => plan.duplicateId),
      );
      await rebuildCanonicalPoi(client, targetId, { noLlm: opts.noLlm });
      await client.query("COMMIT");
      for (const plan of targetPlans) {
        console.log(
          `Consolidated ${plan.duplicateId} -> ${targetId} (${plan.reason}, ${Math.round(plan.distanceM)}m)`,
        );
      }
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }
}

export async function runConsolidation(
  client: PoolClient,
  opts: ConsolidateOptions,
): Promise<number> {
  let total = 0;
  for (let iteration = 1; iteration <= 10; iteration++) {
    if (opts.shouldStop?.()) break;
    const plans = await planMerges(client, opts);
    if (plans.length === 0) break;

    if (opts.dryRun) {
      for (const plan of plans) {
        console.log(
          `DRY consolidate: would merge ${plan.duplicateId} -> ${plan.targetId} (${plan.reason}, ${Math.round(plan.distanceM)}m)`,
        );
      }
      return plans.length;
    }

    await applyPlans(client, plans, opts);
    total += plans.length;
  }
  return total;
}
