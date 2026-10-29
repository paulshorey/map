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
let nextStart = 0;

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

/** Reverse lookup never moves the supplied POI point or claims an official address. */
export async function reverseGeocode(
  lat: number,
  lng: number,
): Promise<ReverseLocation | null> {
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180 ||
    (lat === 0 && lng === 0)
  )
    throw new GeocodeError("Invalid reverse geocode point");
  const call = await beginProviderCall(PROVIDER, "reverse_geocode", null);
  const queued = Date.now();
  let started = queued,
    status: number | undefined,
    headers: Headers | undefined;
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
    const params = new URLSearchParams({
      key: ingestConfig.geocoder.apiKey(),
      lat: String(lat),
      lon: String(lng),
      format: "json",
      addressdetails: "1",
      normalizeaddress: "1",
      statecode: "1",
      zoom: "18",
    });
    let response: Response;
    try {
      providerRequestStarted(call);
      response = await fetch(
        `https://us1.locationiq.com/v1/reverse?${params}`,
        {
          signal: ctx
            ? AbortSignal.any([
                AbortSignal.timeout(60000),
                ctx.execution.abortController.signal,
              ])
            : AbortSignal.timeout(60000),
        },
      );
    } catch {
      if (ctx?.execution.abortController.signal.aborted)
        throw ctx.execution.abortController.signal.reason;
      throw new GeocodeError("Reverse geocoder network error", true);
    }
    status = response.status;
    headers = response.headers;
    providerResponseReceived(call, status);
    if (status !== 404 && !response.ok)
      throw new GeocodeError(
        `Reverse geocoder status ${status}`,
        status === 429 || status >= 500,
        status,
        retryAfterMs(headers.get("retry-after")),
      );
    const hit =
      status === 404
        ? null
        : parseReverseLocation(await response.json(), lat, lng);
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
export function parseReverseLocation(
  body: unknown,
  lat: number,
  lng: number,
): ReverseLocation | null {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new GeocodeError("Invalid reverse geocoder response");
  const row = body as Record<string, unknown>;
  if (row.error === "Unable to geocode") return null;
  const a = row.address as Record<string, unknown> | undefined;
  const rlat = Number(row.lat),
    rlng = Number(row.lon);
  if (
    !a ||
    typeof a !== "object" ||
    Array.isArray(a) ||
    row.lat === null ||
    row.lon === null ||
    row.lat === "" ||
    row.lon === "" ||
    !Number.isFinite(rlat) ||
    !Number.isFinite(rlng) ||
    Math.abs(rlat) > 90 ||
    Math.abs(rlng) > 180
  )
    throw new GeocodeError("Invalid reverse geocoder address");
  const rad = Math.PI / 180,
    dlat = (rlat - lat) * rad,
    dlng = (rlng - lng) * rad;
  const hav =
    Math.sin(dlat / 2) ** 2 +
    Math.cos(lat * rad) * Math.cos(rlat * rad) * Math.sin(dlng / 2) ** 2;
  const country = countryToCode(textValue(a.country_code)) ?? null;
  const stateCode = textValue(a.state_code);
  return {
    country_code: country,
    city: textValue(a.city) ?? textValue(a.town) ?? textValue(a.village),
    region: textValue(a.state),
    region_code:
      stateCode && country
        ? stateCode.startsWith(country + "-")
          ? stateCode
          : `${country}-${stateCode}`
        : null,
    address: textValue(a.road)
      ? [textValue(a.house_number), textValue(a.road)].filter(Boolean).join(" ")
      : null,
    postcode: textValue(a.postcode),
    distance_m: 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, hav))),
    provider: PROVIDER,
    attribution: textValue(row.licence),
  };
}
