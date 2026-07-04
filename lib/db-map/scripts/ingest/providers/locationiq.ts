/**
 * LocationIQ forward-geocode client (M6). Provider is isolated so it can be
 * swapped for self-hosted Nominatim later without touching the geocode loop.
 */
import { ingestConfig } from "../config.js";

export interface GeocodeHit {
  lat: number;
  lng: number;
  /** Coarse precision so the matcher can down-weight centroids (overview §14.6). */
  precision: "point" | "city" | "region";
  provider: string;
}

interface LocationIqRow {
  lat: string;
  lon: string;
  class?: string;
  type?: string;
  display_name?: string;
}

const BASE_URL = "https://us1.locationiq.com/v1/search";
const PROVIDER = "locationiq";

function precisionFrom(row: LocationIqRow): GeocodeHit["precision"] {
  const type = (row.type ?? "").toLowerCase();
  const cls = (row.class ?? "").toLowerCase();
  if (type === "country" || type === "state" || cls === "boundary") return "region";
  if (["city", "town", "village", "administrative", "county", "suburb", "municipality"].includes(type)) {
    return "city";
  }
  return "point";
}

export class GeocodeError extends Error {}

/**
 * Forward-geocode a free-text query. Returns null for a definitive "no result"
 * (a remembered miss). Throws GeocodeError for transient/unexpected failures so
 * the caller can stop rather than cache a false miss.
 */
export async function geocode(query: string): Promise<GeocodeHit | null> {
  const key = ingestConfig.geocoder.apiKey();
  const url = `${BASE_URL}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(
    query,
  )}&format=json&limit=1&normalizeaddress=1`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new GeocodeError(`Network error: ${(err as Error).message}`);
  }

  if (res.status === 404) {
    // LocationIQ returns 404 "Unable to geocode" for no match → definitive miss.
    return null;
  }
  if (res.status === 429) {
    throw new GeocodeError("Rate limited (429)");
  }
  if (!res.ok) {
    throw new GeocodeError(`Unexpected status ${res.status}`);
  }

  const body = (await res.json()) as LocationIqRow[] | { error?: string };
  if (!Array.isArray(body)) {
    // { error: "Unable to geocode" } shape → miss.
    return null;
  }
  const row = body[0];
  if (!row) return null;

  const lat = Number(row.lat);
  const lng = Number(row.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  return { lat, lng, precision: precisionFrom(row), provider: PROVIDER };
}
