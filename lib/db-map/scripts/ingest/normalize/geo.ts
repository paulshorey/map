/** Coordinate validation + swap detection for the normalize stage (M5). */

export interface CoordResult {
  lat: number | null;
  lng: number | null;
  swapped: boolean;
  dropped: boolean;
}

function inLatRange(v: number): boolean {
  return v >= -90 && v <= 90;
}
function inLngRange(v: number): boolean {
  return v >= -180 && v <= 180;
}

/**
 * Validate a coordinate pair, fixing obvious lat/lng swaps and dropping
 * implausible values (out of range, or the 0,0 null-island artifact).
 */
export function fixCoordinates(
  lat: number | null | undefined,
  lng: number | null | undefined,
): CoordResult {
  if (lat === null || lat === undefined || lng === null || lng === undefined) {
    return { lat: null, lng: null, swapped: false, dropped: false };
  }

  // Null island — almost always a missing-data artifact, not a real place.
  if (lat === 0 && lng === 0) {
    return { lat: null, lng: null, swapped: false, dropped: true };
  }

  // Swap detection: lat impossible but the pair works if flipped.
  if (!inLatRange(lat) && inLatRange(lng) && inLngRange(lat)) {
    return { lat: lng, lng: lat, swapped: true, dropped: false };
  }

  if (!inLatRange(lat) || !inLngRange(lng)) {
    return { lat: null, lng: null, swapped: false, dropped: true };
  }

  return { lat, lng, swapped: false, dropped: false };
}
