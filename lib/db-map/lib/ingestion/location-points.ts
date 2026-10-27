import {
  readPrecisionEvidence,
  type PrecisionEvidence,
} from "./geocode-precision.js";
/** Fixed provenance slots; these are not physical roles such as launch/landing. */
export interface MapLocation {
  lat: number;
  lng: number;
  kind: string;
  origin: string;
  precision: string;
  label: string | null;
  query: string | null;
  precision_evidence?: PrecisionEvidence;
}

export interface CoordinateEvidence<T extends MapLocation = MapLocation> {
  source_coordinates: T | null;
  inferred_coordinates: T | null;
}

export function validPoint(
  value: unknown,
): value is { lat: number; lng: number } {
  if (!value || typeof value !== "object") return false;
  const p = value as { lat?: unknown; lng?: unknown };
  return (
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180 &&
    !(p.lat === 0 && p.lng === 0)
  );
}

/** Preserve both independent observations, including when their numeric values agree. */
export function readCoordinateEvidence(value: unknown): CoordinateEvidence {
  const obj =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const read = (
    key: "source_coordinates" | "inferred_coordinates",
    kind: string,
    origin: string,
  ): MapLocation | null => {
    const p = obj[key];
    if (!validPoint(p)) return null;
    const row = p as Record<string, unknown>;
    if (row.kind !== kind || row.origin !== origin) return null;
    const precisionEvidence = readPrecisionEvidence(row.precision_evidence);
    return {
      lat: p.lat,
      lng: p.lng,
      kind,
      origin,
      precision: typeof row.precision === "string" ? row.precision : "point",
      label: typeof row.label === "string" ? row.label : null,
      query: typeof row.query === "string" ? row.query : null,
      ...(precisionEvidence && precisionEvidence.value === row.precision
        ? { precision_evidence: precisionEvidence }
        : {}),
    };
  };
  return {
    source_coordinates: read(
      "source_coordinates",
      "source",
      "source_coordinates",
    ),
    inferred_coordinates: read(
      "inferred_coordinates",
      "inferred",
      "listed_address_geocode",
    ),
  };
}
