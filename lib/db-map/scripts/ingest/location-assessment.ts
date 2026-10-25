import {
  readCoordinateEvidence,
  validPoint,
  type MapLocation,
} from "../../lib/ingestion/location-points.js";
import { stableHash } from "./hash.js";
import { haversineMeters } from "./match/geo.js";
import { countryToCode } from "./normalize/country.js";
import { LOCATION_GEOCODER_VERSION, LOCATION_VERSION } from "./location.js";

export const LOCATION_ASSESSMENT_VERSION = "location-assessment-v1";
// Agreement permits a discovery point, not a claim about a venue entrance.
export const POINT_AGREEMENT_METERS = 250;
export interface AssessmentInput {
  observation_id: string | null;
  normalization_id: string | null;
  geocode_id: string | null;
  captured: Record<string, unknown> | null;
  point: { lat: number | null; lng: number | null };
  coordinate_source: string | null;
  coordinate_precision: string | null;
  projection_location?: Record<string, unknown>;
  geocoder_version: string | null;
  validation: Record<string, unknown> | null;
}
export interface LocationAssessment {
  policy_version: string;
  input_hash: string;
  status: "accepted" | "needs_review" | "unlocated";
  accepted_kind: "source" | "inferred" | null;
  accepted_point: MapLocation | null;
  reasons: string[];
  evidence: Record<string, unknown>;
}
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const countryCode = (value: unknown) =>
  countryToCode(typeof value === "string" ? value : null);
const fold = (v: unknown) =>
  typeof v === "string"
    ? v
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase()
    : "";

/** Pure, conservative consistency policy. Never changes evidence or resolves a conflict by source rank. */
export function assessLocation(input: AssessmentInput): LocationAssessment {
  const result: LocationAssessment = {
    policy_version: LOCATION_ASSESSMENT_VERSION,
    input_hash: stableHash({
      policy_version: LOCATION_ASSESSMENT_VERSION,
      input,
    }),
    status: "needs_review",
    accepted_kind: null,
    accepted_point: null,
    reasons: [],
    evidence: { venue_verified: false, edition_verified: false },
  };
  const v = input.validation;
  const bound =
    !!input.observation_id &&
    !!input.normalization_id &&
    !!input.geocode_id &&
    input.geocoder_version === LOCATION_GEOCODER_VERSION &&
    v?.version === LOCATION_VERSION &&
    v.normalization_id === input.normalization_id &&
    validPoint(v.point) &&
    v.point.lat === input.point.lat &&
    v.point.lng === input.point.lng;
  if (!bound) {
    result.status = validPoint(input.point) ? "needs_review" : "unlocated";
    result.reasons.push("missing_or_stale_coordinate_evidence");
    return result;
  }
  const coordinates = readCoordinateEvidence(v!.coordinate_evidence);
  const source = coordinates.source_coordinates,
    inferred = coordinates.inferred_coordinates;
  result.evidence.coordinate_evidence = coordinates;
  const listed = obj(v!.listed),
    hints = obj(listed.hints);
  const captured = obj(input.captured),
    capturedAttributes = obj(captured.attributes);
  const capturedCountry =
    countryCode(captured.country_code) ??
    countryCode(capturedAttributes.country_name) ??
    countryCode(obj(capturedAttributes.source_location_hints).country);
  const country =
    countryCode(listed.country_code) ?? countryCode(hints.country);
  const reverse = obj(v!.reverse),
    forward = obj(obj(v!.forward).result);
  const reverseCountry = countryCode(reverse.country_code);
  const forwardCountry = countryCode(forward.country_code);
  const warnings = Array.isArray(v!.warnings) ? v!.warnings : [];
  if (
    input.projection_location &&
    ["country_code", "city", "region", "address"].some(
      (field) =>
        (input.projection_location![field] ?? null) !==
        (obj(v!.fields)[field] ?? null),
    )
  )
    result.reasons.push("location_projection_binding_mismatch");
  if (capturedCountry && country && capturedCountry !== country)
    result.reasons.push("listed_country_binding_mismatch");
  if (
    source &&
    validPoint(captured) &&
    (source.lat !== captured.lat || source.lng !== captured.lng)
  )
    result.reasons.push("captured_source_point_changed");
  if (
    (source &&
      (input.coordinate_precision !== "point" ||
        obj(obj(v!.coordinate_evidence).source_coordinates).precision !==
          "point")) ||
    (inferred &&
      obj(obj(v!.coordinate_evidence).inferred_coordinates).precision !==
        "point")
  )
    result.reasons.push("candidate_precision_unverified");
  if (
    source &&
    (!["source", "url"].includes(input.coordinate_source ?? "") ||
      source.lat !== input.point.lat ||
      source.lng !== input.point.lng)
  )
    result.reasons.push("source_candidate_binding_mismatch");
  if (
    inferred &&
    (!inferred.query ||
      !validPoint(forward) ||
      forward.lat !== inferred.lat ||
      forward.lng !== inferred.lng ||
      obj(forward).precision !== inferred.precision)
  )
    result.reasons.push("inferred_candidate_binding_mismatch");
  const conflict =
    (country && reverseCountry && country !== reverseCountry) ||
    (country && forwardCountry && country !== forwardCountry) ||
    warnings.some((w) =>
      [
        "coordinate_country_conflict",
        "coordinate_region_conflict",
        "forward_country_conflict",
        "reverse_result_too_distant",
      ].includes(String(w)),
    );
  result.evidence.listed_country = country ?? null;
  result.evidence.reverse_country = reverseCountry ?? null;
  result.evidence.forward_country_filter =
    obj(v!.forward).country_filter ?? null;
  if (conflict) result.reasons.push("location_text_coordinate_conflict");
  if (!source && !inferred) {
    result.status = "unlocated";
    result.reasons.push("missing_coordinate_candidates");
    return result;
  }
  if (source && inferred) {
    const distance = haversineMeters(source, inferred);
    result.evidence.distance_m = distance;
    result.evidence.agreement_threshold_m = POINT_AGREEMENT_METERS;
    if (distance > POINT_AGREEMENT_METERS)
      result.reasons.push("coordinate_candidates_disagree");
    if (source.precision !== "point" || inferred.precision !== "point")
      result.reasons.push("coarse_coordinate_candidates");
    if (!country) result.reasons.push("listed_country_missing");
    if (result.reasons.length === 0) {
      result.accepted_point = source;
      result.reasons.push("point_candidates_agree");
    }
  } else {
    const point = source ?? inferred!;
    // Reverse evidence belongs to validation.point, never to an arbitrary second candidate.
    const reverseAgrees =
      point.lat === input.point.lat &&
      point.lng === input.point.lng &&
      country &&
      reverseCountry === country &&
      !!fold(listed.city) &&
      fold(listed.city) === fold(reverse.city) &&
      typeof reverse.distance_m === "number" &&
      Number.isFinite(reverse.distance_m) &&
      reverse.distance_m >= 0 &&
      reverse.distance_m <= 1000;
    if (point.precision !== "point")
      result.reasons.push("coarse_coordinate_candidates");
    if (!reverseAgrees)
      result.reasons.push("insufficient_independent_locality_evidence");
    if (result.reasons.length === 0) {
      result.accepted_point = point;
      result.reasons.push("point_reverse_locality_agree");
    }
  }
  if (result.accepted_point) {
    result.status = "accepted";
    result.accepted_kind = result.accepted_point.kind as "source" | "inferred";
  }
  return result;
}
