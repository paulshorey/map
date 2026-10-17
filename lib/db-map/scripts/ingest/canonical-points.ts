import {
  capturedPoints,
  twoPoints,
  validPoint,
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

/** Read only exact active artifact evidence; raw/model attributes cannot publish markers. */
function memberPoints(row: LocationMember): MapLocation[] {
  const v = row.location_validation;
  if (
    !v ||
    v.version !== LOCATION_VERSION ||
    v.normalization_id !== row.active_normalization_id ||
    !row.active_geocode_id ||
    !validPoint(v.point) ||
    v.point.lat !== row.lat ||
    v.point.lng !== row.lng ||
    !Array.isArray(v.locations)
  )
    return [];
  // Validate numbers using the shared parser, but preserve derivation/role metadata.
  return capturedPoints(v.locations).map((p) => {
    const original = (v.locations as MapLocation[]).find(
      (r) => r.lat === p.lat && r.lng === p.lng,
    )!;
    return { ...p, origin: original.origin, query: original.query ?? null };
  });
}

export function canonicalPoints(
  rows: LocationMember[],
  anchor: LocationMember | null,
): CanonicalMapLocation[] {
  if (!anchor || !validPoint(anchor)) return [];
  const attach = (
    row: LocationMember,
    p: MapLocation,
  ): CanonicalMapLocation => ({
    ...p,
    research_id: row.id,
    source_id: row.source_id,
    source: row.source_slug,
    normalization_id: row.active_normalization_id,
    geocode_id: row.active_geocode_id,
  });
  const own = memberPoints(anchor);
  const primary = own.find(
    (p) => p.lat === anchor.lat && p.lng === anchor.lng,
  ) ?? {
    lat: anchor.lat!,
    lng: anchor.lng!,
    origin: anchor.coordinate_source === "geocode"
      ? "geocode"
      : ["source", "url"].includes(anchor.coordinate_source ?? "")
        ? "source_coordinates"
        : "legacy_coordinates",
    role: "primary",
    precision: anchor.coordinate_precision ?? "point",
    label: null,
    query: null,
  };
  const candidates = [
    ...own.map((p) => attach(anchor, p)),
    ...rows
      .filter((r) => r.id !== anchor.id)
      .sort(
        (a, b) => b.source_trust - a.source_trust || a.id.localeCompare(b.id),
      )
      .flatMap((row) => {
        const points = memberPoints(row);
        // An additional location beats another source's competing primary when
        // the chosen anchor is legacy-only. Preserve every candidate in its artifact.
        return [
          ...points.filter((p) => p.lat !== row.lat || p.lng !== row.lng),
          ...points.filter((p) => p.lat === row.lat && p.lng === row.lng),
        ].map((p) => attach(row, p));
      }),
  ];
  return twoPoints([attach(anchor, primary), ...candidates]);
}
