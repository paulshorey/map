import {
  readCoordinateEvidence,
  validPoint,
  type CoordinateEvidence,
  type MapLocation,
} from "../../lib/ingestion/location-points.js";
import { LOCATION_VERSION } from "./location.js";

export interface LocationMember {
  id: string;
  source_id: string;
  source_slug: string;
  source_trust: number;
  lat: number | null;
  lng: number | null;
  coordinate_precision: string | null;
  coordinate_source?: string | null;
  active_normalization_id: string | null;
  active_geocode_id: string | null;
  location_validation: Record<string, unknown> | null;
}
export interface CanonicalMapLocation extends MapLocation {
  research_id: string;
  source_id: string;
  source: string;
  normalization_id: string | null;
  geocode_id: string | null;
}

function sourceFallback(row: LocationMember): MapLocation | null {
  if (
    !validPoint(row) ||
    !["source", "url"].includes(row.coordinate_source ?? "")
  )
    return null;
  return {
    lat: row.lat!,
    lng: row.lng!,
    kind: "source",
    origin: "source_coordinates",
    precision: row.coordinate_precision ?? "point",
    label: null,
    query: null,
  };
}

function memberEvidence(row: LocationMember): CoordinateEvidence {
  const v = row.location_validation;
  if (
    !v ||
    v.version !== LOCATION_VERSION ||
    v.normalization_id !== row.active_normalization_id ||
    !row.active_geocode_id ||
    !validPoint(v.point) ||
    v.point.lat !== row.lat ||
    v.point.lng !== row.lng
  )
    return {
      source_coordinates: sourceFallback(row),
      inferred_coordinates: null,
    };
  return readCoordinateEvidence(v.coordinate_evidence);
}

/** Choose one value independently for each provenance slot; source points cannot occupy the inferred slot. */
export function canonicalCoordinateEvidence(
  rows: LocationMember[],
  anchor: LocationMember | null,
): CoordinateEvidence<CanonicalMapLocation> {
  const ordered = [
    ...(anchor ? [anchor] : []),
    ...rows
      .filter((r) => r.id !== anchor?.id)
      .sort(
        (a, b) => b.source_trust - a.source_trust || a.id.localeCompare(b.id),
      ),
  ];
  const result: CoordinateEvidence<CanonicalMapLocation> = {
    source_coordinates: null,
    inferred_coordinates: null,
  };
  for (const row of ordered) {
    const evidence = memberEvidence(row);
    for (const slot of [
      "source_coordinates",
      "inferred_coordinates",
    ] as const) {
      const p = evidence[slot];
      if (result[slot] || !p) continue;
      result[slot] = {
        ...p,
        research_id: row.id,
        source_id: row.source_id,
        source: row.source_slug,
        normalization_id: row.active_normalization_id,
        geocode_id: row.active_geocode_id,
      };
    }
  }
  return result;
}

/** Legacy output remains one stored point when its listed-text evidence is unavailable. */
export function canonicalPoints(
  rows: LocationMember[],
  anchor: LocationMember | null,
): CanonicalMapLocation[] {
  const e = canonicalCoordinateEvidence(rows, anchor);
  const points = [e.source_coordinates, e.inferred_coordinates].filter(
    (p): p is CanonicalMapLocation => !!p,
  );
  if (points.length || !anchor || !validPoint(anchor)) return points;
  return [
    {
      lat: anchor.lat!,
      lng: anchor.lng!,
      kind: "legacy",
      origin:
        anchor.coordinate_source === "geocode"
          ? "geocode"
          : "legacy_coordinates",
      precision: anchor.coordinate_precision ?? "point",
      label: null,
      query: null,
      research_id: anchor.id,
      source_id: anchor.source_id,
      source: anchor.source_slug,
      normalization_id: anchor.active_normalization_id,
      geocode_id: anchor.active_geocode_id,
    },
  ];
}
