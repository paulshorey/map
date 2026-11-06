/**
 * Every location a geocode artifact knows for its research record, accepted or rejected.
 * Stored in `research_poi_locations` (one immutable set per artifact) so canonical builds
 * can map all of them; see `canonical-locations.ts`.
 */
import { LOCATION_VERSION } from "./location.js";

export type LocationKind = "source" | "inferred";
export type LocationOrigin =
  | "source_coordinates"
  | "url_coordinates"
  | "listed_address_geocode"
  | "city_fallback"
  | "country_fallback";
export type LocationRole = "venue" | "address" | "locality" | "region" | "country";
export type LocationPrecision = "point" | "city" | "region" | "country";

export interface RecordLocation {
  kind: LocationKind;
  origin: LocationOrigin;
  role: LocationRole;
  precision: LocationPrecision;
  status: "accepted" | "rejected";
  reason: string | null;
  lat: number;
  lng: number;
  label: string | null;
  query: string | null;
  query_basis: string | null;
  evidence: Record<string, unknown>;
  logic_version: string;
}

interface Point {
  lat: number;
  lng: number;
  precision?: string | null;
  label?: string | null;
  precision_evidence?: unknown;
}

const PRECISIONS = new Set(["point", "city", "region", "country"]);
const precisionOf = (value: unknown): LocationPrecision =>
  PRECISIONS.has(String(value)) ? (value as LocationPrecision) : "point";
const valid = (p: Point | null | undefined): p is Point =>
  !!p &&
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lng) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lng) <= 180 &&
  !(p.lat === 0 && p.lng === 0);

/** What a point stands for, from how it was obtained and how precise it is. */
export function locationRole(
  precision: LocationPrecision,
  basis: string | null,
): LocationRole {
  if (precision === "country") return "country";
  if (precision === "region") return "region";
  if (precision === "city") return "locality";
  if (basis === "address") return "address";
  if (basis === "locality") return "locality";
  return "venue";
}

export function recordLocations(input: {
  /** The supplied point, when the listing gave one. */
  source: (Point & { coordinate_source?: string | null }) | null;
  /** The accepted listed-text lookup (or its city/country fallback). */
  inferred: (Point & { query?: string | null }) | null;
  basis: string | null;
  fallbackFrom: { reason: string; query: string } | null;
  /** Rejected lookups, newest first (`validation.forward.rejected` chain). */
  rejected: { reason?: string; query?: string; result?: Point | null; previous?: unknown } | null;
}): RecordLocation[] {
  const out: RecordLocation[] = [];
  const base = { logic_version: LOCATION_VERSION };
  if (valid(input.source)) {
    const precision = precisionOf(input.source.precision);
    out.push({
      ...base,
      kind: "source",
      origin:
        input.source.coordinate_source === "url" ? "url_coordinates" : "source_coordinates",
      role: locationRole(precision, null),
      precision,
      status: "accepted",
      reason: null,
      lat: input.source.lat,
      lng: input.source.lng,
      label: input.source.label ?? null,
      query: null,
      query_basis: null,
      evidence: {},
    });
  }
  if (valid(input.inferred)) {
    const precision = precisionOf(input.inferred.precision);
    out.push({
      ...base,
      kind: "inferred",
      origin: input.fallbackFrom
        ? precision === "country"
          ? "country_fallback"
          : "city_fallback"
        : "listed_address_geocode",
      role: locationRole(precision, input.basis),
      precision,
      status: "accepted",
      reason: null,
      lat: input.inferred.lat,
      lng: input.inferred.lng,
      label: input.inferred.label ?? null,
      query: input.inferred.query ?? null,
      query_basis: input.basis,
      evidence: {
        ...(input.inferred.precision_evidence
          ? { precision_evidence: input.inferred.precision_evidence }
          : {}),
        ...(input.fallbackFrom ? { fallback_from: input.fallbackFrom } : {}),
      },
    });
  }
  for (
    let r = input.rejected as typeof input.rejected | undefined;
    r;
    r = r.previous as typeof input.rejected | undefined
  ) {
    if (!valid(r.result ?? null)) continue;
    const result = r.result!;
    const precision = precisionOf(result.precision);
    out.push({
      ...base,
      kind: "inferred",
      origin: "listed_address_geocode",
      role: locationRole(precision, null),
      precision,
      status: "rejected",
      reason: r.reason ?? "rejected",
      lat: result.lat,
      lng: result.lng,
      label: result.label ?? null,
      query: r.query ?? null,
      query_basis: null,
      evidence: {},
    });
  }
  return out;
}
