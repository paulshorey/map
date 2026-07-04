/**
 * Extract lat/lng embedded in URLs (Google Maps, OSM, …) so records carrying a
 * maps link never need a geocoder call (data-quality contract, Location rule 5).
 */

export interface UrlCoords {
  lat: number;
  lng: number;
}

// Ordered by specificity; each pattern captures (lat, lng).
const PATTERNS: RegExp[] = [
  // Google Maps place pin: ...!3d34.0430175!4d-118.2672541
  /!3d(-?\d{1,3}(?:\.\d+))!4d(-?\d{1,3}(?:\.\d+))/,
  // Google Maps viewport: .../@34.0430175,-118.2672541,15z
  /@(-?\d{1,3}(?:\.\d+)),(-?\d{1,3}(?:\.\d+))/,
  // Google Maps search/query: /maps/search/34.04,-118.26 or ?q=34.04,-118.26 or ?ll=…
  /[/=?&](?:q|ll|query|destination|center)=(-?\d{1,3}(?:\.\d+)),\s*(-?\d{1,3}(?:\.\d+))/,
  /\/maps\/search\/(-?\d{1,3}(?:\.\d+)),\s*(-?\d{1,3}(?:\.\d+))/,
  // OpenStreetMap: ?mlat=51.5&mlon=-0.1
  /[?&]mlat=(-?\d{1,3}(?:\.\d+))&mlon=(-?\d{1,3}(?:\.\d+))/,
];

function validPair(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/** Extract coordinates from a single URL-ish string. Returns null when none found. */
export function coordsFromUrl(url: string | null | undefined): UrlCoords | null {
  if (!url) return null;
  for (const re of PATTERNS) {
    const m = re.exec(url);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (validPair(lat, lng)) return { lat, lng };
  }
  return null;
}

/**
 * Scan every URL-bearing string in the record's fields (website, source_url, and
 * any string values in attributes) for embedded coordinates. First hit wins.
 */
export function coordsFromRecordUrls(fields: {
  website?: string | null;
  source_url?: string | null;
  attributes?: Record<string, unknown> | null;
}): UrlCoords | null {
  const candidates: (string | null | undefined)[] = [fields.website, fields.source_url];
  if (fields.attributes) {
    for (const v of Object.values(fields.attributes)) {
      if (typeof v === "string" && v.includes("://")) candidates.push(v);
    }
  }
  for (const c of candidates) {
    const hit = coordsFromUrl(c);
    if (hit) return hit;
  }
  return null;
}
