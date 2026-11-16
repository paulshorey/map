/**
 * LocationIQ forward-geocode client (M6). Provider is isolated so it can be
 * swapped for self-hosted Nominatim later without touching the geocode loop.
 */
import { countryToCode } from "../normalize/country.js";
import { textValue, type ReverseLocation } from "../location.js";
import { ingestConfig } from "../config.js";
import { LlmError, retryAfterMs } from "./llm.js";
import { currentAttempt } from "../execution.js";
import {
  deriveForwardPrecision,
  type PrecisionEvidence,
} from "../../../lib/ingestion/geocode-precision.js";
import {
  beginProviderCall,
  endProviderCall,
  providerRequestStarted,
  providerResponseReceived,
} from "../provider-telemetry.js";
import {
  markProviderRateLimitedDay,
  reserveProviderRequest,
} from "./quota.js";
let nextStart = 0;

/** Non-OK status: "Rate Limited Day" stops all lookups until 00:00 UTC; others may retry. */
async function statusError(
  res: Response,
  label: string,
  release: () => Promise<void>,
): Promise<Error> {
  const status = res.status;
  let body = "";
  try {
    body = await res.text();
  } catch {
    // The status alone still classifies the failure.
  }
  if (status === 429 && /rate limited day/i.test(body))
    return markProviderRateLimitedDay(PROVIDER);
  // LocationIQ does not charge unsuccessful requests (400 invalid query, 429, 5xx, ...).
  await release();
  return new GeocodeError(
    `${label} status ${status}`,
    status === 429 || status >= 500,
    status,
    retryAfterMs(res.headers.get("retry-after")),
  );
}

export interface GeocodeHit {
  lat: number;
  lng: number;
  /** Coarse precision so the matcher can down-weight centroids (overview §14.6). */
  precision: "point" | "city" | "region" | "country";
  provider: string;
  label?: string | null;
  attribution?: string | null;
  country_code?: string | null;
  city?: string | null;
  region?: string | null;
  provider_class?: string | null;
  provider_type?: string | null;
  precision_evidence?: PrecisionEvidence;
  /** Exact selected response row; request URLs/credentials are never included. */
  raw_response?: Record<string, unknown>;
}

interface LocationIqRow {
  lat: string;
  lon: string;
  class?: string;
  type?: string;
  display_name?: string;
  licence?: string;
  address?: Record<string, unknown>;
}

const BASE_URL = "https://us1.locationiq.com/v1/search";
const PROVIDER = "locationiq";

export class GeocodeError extends LlmError {}

/**
 * Forward-geocode a free-text query. Returns null for a definitive "no result"
 * (a remembered miss). Throws GeocodeError for transient/unexpected failures so
 * the caller can stop rather than cache a false miss.
 */
export async function geocode(
  query: string,
  countryCode?: string | null,
): Promise<GeocodeHit | null> {
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
    const release = await reserveProviderRequest(PROVIDER);
    let res: Response;
    try {
      const params = new URLSearchParams({
        key,
        q: query,
        format: "json",
        limit: "1",
        normalizeaddress: "1",
        addressdetails: "1",
      });
      const country = countryToCode(countryCode);
      if (country) params.set("countrycodes", country.toLowerCase());
      providerRequestStarted(call);
      res = await fetch(`${BASE_URL}?${params}`, {
        signal: ctx
          ? AbortSignal.any([
              AbortSignal.timeout(60000),
              ctx.execution.abortController.signal,
            ])
          : AbortSignal.timeout(60000),
      });
    } catch (error) {
      await release();
      if (ctx?.execution.abortController.signal.aborted)
        throw ctx.execution.abortController.signal.reason;
      throw new GeocodeError(
        `Network error: ${(error as Error).message}`,
        true,
      );
    }
    headers = res.headers;
    status = res.status;
    providerResponseReceived(call, status);
    if (status !== 404 && !res.ok)
      throw await statusError(res, "Geocoder", release);
    // "Unable to geocode" is an unsuccessful (uncharged) request, though its miss is cached.
    if (status === 404) await release();
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
          row.lat === null ||
          row.lat === "" ||
          row.lon === null ||
          row.lon === "" ||
          (lat === 0 && lng === 0) ||
          !Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          Math.abs(lat) > 90 ||
          Math.abs(lng) > 180
        )
          throw new GeocodeError("Invalid geocoder coordinates");
        const raw_response = row as unknown as Record<string, unknown>;
        const precision_evidence = deriveForwardPrecision(raw_response);
        hit = {
          lat,
          lng,
          precision: precision_evidence.value as GeocodeHit["precision"],
          precision_evidence,
          raw_response,
          provider: PROVIDER,
          label: textValue(row.display_name),
          attribution: textValue(row.licence),
          country_code:
            countryToCode(textValue(row.address?.country_code)) ?? null,
          city: textValue(row.address?.city) ?? textValue(row.address?.town),
          region: textValue(row.address?.state),
          provider_class: textValue(row.class),
          provider_type: textValue(row.type),
        };
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
