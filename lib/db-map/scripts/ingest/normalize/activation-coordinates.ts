import type { DeterministicFacts } from "./deterministic.js";
import { fixCoordinates } from "./geo.js";

export interface CoordinateProjection {
  active_normalization_id: string | null;
  active_geocode_id: string | null;
  geocode_normalization_id: string | null;
  projected_lat: number | null;
  projected_lng: number | null;
  coordinate_source: string | null;
  coordinate_precision: string | null;
}

/** Activate validated source/URL coordinates; retain a geocode only for this exact artifact. */
export function activationCoordinates(
  row: CoordinateProjection,
  normalizationId: string,
  facts: Pick<
    DeterministicFacts,
    "lat" | "lng" | "coordinateSource" | "coordinatePrecision"
  >,
) {
  const current = fixCoordinates(row.projected_lat, row.projected_lng);
  const keepGeocode =
    row.active_normalization_id === normalizationId &&
    row.geocode_normalization_id === normalizationId &&
    (row.coordinate_source === "geocode" ||
      (row.projected_lat === facts.lat && row.projected_lng === facts.lng)) &&
    row.active_geocode_id !== null &&
    current.lat !== null &&
    current.lng !== null &&
    !current.swapped &&
    !current.dropped;
  const lat = keepGeocode ? row.projected_lat : facts.lat;
  const lng = keepGeocode ? row.projected_lng : facts.lng;
  const changed = row.projected_lat !== lat || row.projected_lng !== lng;
  return {
    lat,
    lng,
    source: keepGeocode ? row.coordinate_source : facts.coordinateSource,
    precision: keepGeocode
      ? row.coordinate_precision
      : facts.coordinatePrecision,
    keepGeocode,
    changed,
    needsActivation:
      changed || (!keepGeocode && row.active_geocode_id !== null),
  };
}
