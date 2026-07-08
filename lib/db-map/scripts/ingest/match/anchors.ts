import { ingestConfig } from "../config.js";
import { haversineMeters, type Point } from "./geo.js";
import { nameSimilarity, normalizeComparable } from "./text.js";

export const PROXIMITY_MERGE_DEG: Record<string, number> = {
  gardens: 0.0055,
  botanical_garden: 0.0055,
  arboretum: 0.0055,
  campground: 0.0005,
  rv: 0.0005,
  tent: 0.0005,
  music_festival: 0,
  carnival: 0,
  art_fair: 0,
  art_parade: 0,
};

const CATEGORY_STOPWORDS = new Set([
  "arboretum",
  "botanic",
  "botanical",
  "botanico",
  "botanischer",
  "garden",
  "gardens",
  "garten",
  "jardin",
  "jardim",
  "park",
  "parque",
  "rose",
  "rosarium",
  "camp",
  "campground",
  "campgrounds",
  "camping",
  "rv",
  "tent",
  "festival",
  "fair",
  "carnival",
  "parade",
  "植物园",
  "植物園",
  "月季园",
  "月季園",
  "花园",
  "花園",
]);

export interface AnchorMeta {
  canonical_id?: string;
  popularity: number;
  max_source_trust: number;
  has_website: boolean;
  has_wikidata_qid: boolean;
}

export interface ResearchAnchorMeta {
  source_trust: number;
  website: string | null;
  attributes: Record<string, unknown> | null;
  raw: unknown;
}

export function proximityDegFor(slugs: string[] | null | undefined): number {
  if (!slugs || slugs.length === 0) return ingestConfig.match.proximityMergeDeg;
  return Math.max(
    ...slugs.map((slug) => PROXIMITY_MERGE_DEG[slug] ?? ingestConfig.match.proximityMergeDeg),
  );
}

export function isWithinProximityBox(a: Point, b: Point, slugs: string[] | null | undefined): boolean {
  const deg = proximityDegFor(slugs);
  return deg > 0 && Math.abs(a.lat - b.lat) <= deg && Math.abs(a.lng - b.lng) <= deg;
}

export function isAnchor(meta: AnchorMeta): boolean {
  return (
    meta.popularity >= 2 ||
    meta.max_source_trust >= 80 ||
    meta.has_website
  );
}

export function canonicalAnchorSort(a: AnchorMeta, b: AnchorMeta): number {
  return (
    b.popularity - a.popularity ||
    b.max_source_trust - a.max_source_trust ||
    String(a.canonical_id ?? "").localeCompare(String(b.canonical_id ?? ""))
  );
}

export function hasResearchStrongIdentity(row: ResearchAnchorMeta): boolean {
  return row.source_trust >= 80;
}

export function isSatelliteLikeResearch(
  row: ResearchAnchorMeta,
  candidateNameSimilarity: number,
): boolean {
  if (hasResearchStrongIdentity(row)) return false;
  return !row.website || candidateNameSimilarity < 0.72;
}

export function distinctiveName(value: string | null | undefined): boolean {
  const normalized = normalizeComparable(value);
  if (!normalized) return false;

  const words = normalized.split(" ").filter(Boolean);
  if (words.some((word) => !CATEGORY_STOPWORDS.has(word))) return true;

  // CJK source names often normalize as a single token; treat names made only of common
  // garden words as generic and anything with extra characters as distinctive.
  const genericCjk = ["植物园", "植物園", "月季园", "月季園", "花园", "花園"];
  return !genericCjk.includes(normalized);
}

export function normalizedExactName(a: string | null | undefined, b: string | null | undefined): boolean {
  const aa = normalizeComparable(a);
  const bb = normalizeComparable(b);
  return aa.length > 0 && aa === bb;
}

export function pairDistanceM(a: Point, b: Point): number {
  return haversineMeters(a, b);
}

export function pairNameSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  return nameSimilarity(a, b);
}
