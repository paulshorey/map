/**
 * LocationIQ forward-geocode client (M6). Provider is isolated so it can be
 * swapped for self-hosted Nominatim later without touching the geocode loop.
 */
import { ingestConfig } from "../config.js";
import { LlmError, retryAfterMs } from "./llm.js";
import { currentAttempt } from "../execution.js";
import { beginProviderCall, endProviderCall } from "../provider-telemetry.js";
let nextStart = 0;

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
  if (type === "country" || type === "state" || cls === "boundary")
    return "region";
  if (
    [
      "city",
      "town",
      "village",
      "administrative",
      "county",
      "suburb",
      "municipality",
    ].includes(type)
  ) {
    return "city";
  }
  return "point";
}

export class GeocodeError extends LlmError {}

/**
 * Forward-geocode a free-text query. Returns null for a definitive "no result"
 * (a remembered miss). Throws GeocodeError for transient/unexpected failures so
 * the caller can stop rather than cache a false miss.
 */
export async function geocode(query: string): Promise<GeocodeHit | null> {
  const key = ingestConfig.geocoder.apiKey();
  const call = await beginProviderCall(PROVIDER, "geocode", null),
    queued = Date.now();
  let headers: Headers | undefined,
    status: number | undefined,
    started = Date.now();
  try {
    await new Promise((r) =>
      setTimeout(r, Math.max(0, nextStart - Date.now())),
    );
    const ctx = currentAttempt();
    if (ctx?.execution.stopped)
      throw Object.assign(new Error("Geocode admission stopped"), {
        code: "ingest_paused",
      });
    nextStart = Date.now() + 1000;
    started = Date.now();
    let res: Response;
    try {
      res = await fetch(
        `${BASE_URL}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query)}&format=json&limit=1&normalizeaddress=1`,
        {
          signal: ctx
            ? AbortSignal.any([
                AbortSignal.timeout(60000),
                ctx.execution.abortController.signal,
              ])
            : AbortSignal.timeout(60000),
        },
      );
    } catch (error) {
      throw new GeocodeError(
        `Network error: ${(error as Error).message}`,
        true,
      );
    }
    headers = res.headers;
    status = res.status;
    if (status !== 404 && !res.ok)
      throw new GeocodeError(
        `Geocoder status ${status}`,
        status === 429 || status >= 500,
        status,
        retryAfterMs(headers.get("retry-after")),
      );
    let hit: GeocodeHit | null = null;
    if (status !== 404) {
      const body = (await res.json()) as LocationIqRow[] | { error?: string };
      if (!Array.isArray(body) && body.error !== "Unable to geocode")
        throw new GeocodeError("Invalid geocoder response");
      const row = Array.isArray(body) ? body[0] : undefined;
      if (row) {
        const lat = Number(row.lat),
          lng = Number(row.lon);
        if (
          !Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          Math.abs(lat) > 90 ||
          Math.abs(lng) > 180
        )
          throw new GeocodeError("Invalid geocoder coordinates");
        hit = { lat, lng, precision: precisionFrom(row), provider: PROVIDER };
      }
    }
    await endProviderCall(call, {
      queueMs: started - queued,
      latencyMs: Date.now() - started,
      status,
      headers,
    });
    return hit;
  } catch (error) {
    await endProviderCall(call, {
      queueMs: started - queued,
      latencyMs: Date.now() - started,
      status,
      headers,
      error,
    });
    throw error;
  }
}
