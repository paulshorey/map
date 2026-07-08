import { strongContactSignal } from "./denylist.js";
import { distanceScore } from "./geo.js";
import { cosineSimilarity, nameSimilarity, sameText } from "./text.js";

export interface ScoreInput {
  current: {
    name: string | null;
    name_normalized: string | null;
    content_embedding: number[] | null;
    website_domain: string | null;
    phone: string | null;
    city: string | null;
    region: string | null;
    country_code: string | null;
    coordinate_precision: string | null;
  };
  candidate: {
    name: string | null;
    name_normalized: string | null;
    content_embedding: number[] | null;
    website_domain: string | null;
    phone: string | null;
    city: string | null;
    region: string | null;
    country_code: string | null;
    coordinate_precision: string | null;
  };
  distanceM: number;
  radiusM: number;
}

export interface MatchSignals {
  name: number;
  embedding: number | null;
  semantic: number;
  distance: number | null;
  locality: number;
  website: boolean;
  phone: boolean;
  coarseCoordinate: boolean;
  similarityFloorPassed: boolean;
}

export interface CandidateScore {
  score: number;
  signals: MatchSignals;
}

function coarsePrecision(value: string | null): boolean {
  // NULL is treated as unknown/coarse per the M8 plan, because older rows may predate provenance.
  return value !== "point";
}

function localityScore(a: ScoreInput["current"], b: ScoreInput["candidate"]): number {
  let score = 0;
  let possible = 0;
  for (const [left, right, weight] of [
    [a.country_code, b.country_code, 0.4],
    [a.region, b.region, 0.3],
    [a.city, b.city, 0.3],
  ] as const) {
    if (!left || !right) continue;
    possible += weight;
    if (sameText(left, right)) score += weight;
  }
  return possible === 0 ? 0 : score / possible;
}

export function scoreCandidate(input: ScoreInput): CandidateScore {
  const name = nameSimilarity(
    input.current.name_normalized ?? input.current.name,
    input.candidate.name_normalized ?? input.candidate.name,
  );
  const embedding = cosineSimilarity(
    input.current.content_embedding,
    input.candidate.content_embedding,
  );
  const semantic = embedding === null ? name : embedding * 0.55 + name * 0.45;
  const coarseCoordinate =
    coarsePrecision(input.current.coordinate_precision) ||
    coarsePrecision(input.candidate.coordinate_precision);
  const distance = coarseCoordinate ? null : distanceScore(input.distanceM, input.radiusM);
  const locality = localityScore(input.current, input.candidate);
  const contact = strongContactSignal(
    input.current.website_domain,
    input.candidate.website_domain,
    input.current.phone,
    input.candidate.phone,
  );

  // Proximity/locality/contact together cannot push a low-similarity pair over T_high.
  const score =
    semantic * 0.8 +
    (distance ?? 0) * 0.12 +
    locality * 0.04 +
    (contact.website ? 0.02 : 0) +
    (contact.phone ? 0.02 : 0);

  const similarityFloorPassed =
    name >= 0.72 && (embedding === null || embedding >= 0.72);

  return {
    score: Math.min(1, score),
    signals: {
      name,
      embedding,
      semantic,
      distance,
      locality,
      website: contact.website,
      phone: contact.phone,
      coarseCoordinate,
      similarityFloorPassed,
    },
  };
}
