import { stableHash } from "../hash.js";
import { countryToCode } from "./country.js";
import { fixCoordinates } from "./geo.js";
import { normalizePhone, websiteDomain } from "./text.js";
import { coordsFromRecordUrls } from "./urlcoords.js";

export interface ValueCandidate<T> {
  id: string;
  value: T;
  path: string;
  roleHint?: string;
}

export interface DeterministicFacts {
  normalizedName: string | null;
  countryCode: string | null;
  phone: string | null;
  websiteDomain: string | null;
  startDate: string | null;
  endDate: string | null;
  datePrecision: "day" | "month" | "year" | null;
  lat: number | null;
  lng: number | null;
  coordinateSource: "source" | "url" | null;
  coordinatePrecision: "point" | null;
  urlCandidates: ValueCandidate<string>[];
  phoneCandidates: ValueCandidate<string>[];
  emailCandidates: ValueCandidate<string>[];
  coordinateCandidates: ValueCandidate<{ lat: number; lng: number }>[];
  hardIsPoi: boolean | null;
  warnings: string[];
}

export interface DeterministicInput {
  name: string | null;
  description: string | null;
  website: string | null;
  source_url: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  lat: number | null;
  lng: number | null;
  attributes: Record<string, unknown>;
  raw: unknown;
  sourceIsPoiHint: boolean | null;
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function collectStringFields(
  value: unknown,
  predicate: (key: string, value: string) => boolean,
  path = "$.raw",
  out: Array<{ path: string; value: string }> = [],
): Array<{ path: string; value: string }> {
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectStringFields(child, predicate, `${path}[${index}]`, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (typeof child === "string" && predicate(key, child)) out.push({ path: childPath, value: child });
    else collectStringFields(child, predicate, childPath, out);
  }
  return out;
}

function uniqueCandidates<T>(
  prefix: string,
  values: Array<{ value: T; path: string; roleHint?: string }>,
  key: (value: T) => string,
): ValueCandidate<T>[] {
  const seen = new Set<string>();
  const output: ValueCandidate<T>[] = [];
  for (const candidate of values) {
    const normalized = key(candidate.value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push({ id: `${prefix}_${output.length + 1}`, ...candidate });
  }
  return output;
}

function validCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1800 || year > new Date().getUTCFullYear() + 10) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function strictDate(raw: unknown): {
  iso: string;
  precision: "day" | "month" | "year";
} | null {
  const value = stringValue(raw);
  if (!value) return null;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value);
  if (!match) match = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!validCalendarDate(year, month, day)) return null;
    return {
      iso: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
      precision: "day",
    };
  }
  const yearOnly = /^(\d{4})$/.exec(value);
  if (yearOnly) {
    const year = Number(yearOnly[1]);
    if (year >= 1800 && year <= new Date().getUTCFullYear() + 10) {
      return { iso: `${year}-01-01`, precision: "year" };
    }
  }
  return null;
}

function candidateDate(attributes: Record<string, unknown>, raw: unknown, keys: string[]): unknown {
  for (const key of keys) {
    if (attributes[key] !== undefined && attributes[key] !== null) return attributes[key];
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    for (const key of keys) {
      if (record[key] !== undefined && record[key] !== null) return record[key];
    }
  }
  return undefined;
}

function compareIso(a: string, b: string): number {
  return a.localeCompare(b);
}

export function buildDeterministicFacts(input: DeterministicInput): DeterministicFacts {
  const warnings: string[] = [];
  const rawRecord =
    input.raw && typeof input.raw === "object" && !Array.isArray(input.raw)
      ? (input.raw as Record<string, unknown>)
      : {};
  const fixed = fixCoordinates(input.lat, input.lng);
  if (fixed.dropped) warnings.push("invalid_source_coordinates");
  if (fixed.swapped) warnings.push("swapped_source_coordinates");

  let lat = fixed.lat;
  let lng = fixed.lng;
  let coordinateSource: "source" | "url" | null = lat !== null && lng !== null ? "source" : null;

  const urls = collectStringFields(input.raw, (_key, value) => {
    try {
      new URL(value);
      return /^https?:\/\//i.test(value);
    } catch {
      return false;
    }
  });
  const explicitUrls: Array<{ value: string; path: string; roleHint?: string }> = [];
  if (input.website) explicitUrls.push({ value: input.website, path: "$.captured.website", roleHint: "official_candidate" });
  if (input.source_url) explicitUrls.push({ value: input.source_url, path: "$.captured.source_url", roleHint: "source_listing" });
  explicitUrls.push(...urls.map((entry) => ({ ...entry, roleHint: "unknown" })));
  const urlCandidates = uniqueCandidates("url", explicitUrls.slice(0, 30), (value) => value.trim());

  if (lat === null) {
    const fromUrl = coordsFromRecordUrls({
      website: input.website,
      source_url: input.source_url,
      attributes: input.attributes,
    });
    if (fromUrl) {
      lat = fromUrl.lat;
      lng = fromUrl.lng;
      coordinateSource = "url";
    }
  }

  const coordinateCandidates =
    lat !== null && lng !== null
      ? [{ id: "coord_1", value: { lat, lng }, path: coordinateSource === "source" ? "$.captured.coordinates" : "$.captured.urls" }]
      : [];

  const rawPhones = collectStringFields(input.raw, (key) => /phone|telephone|tel/i.test(key));
  const phoneValues = [
    ...(input.phone ? [{ value: input.phone, path: "$.captured.phone" }] : []),
    ...rawPhones,
  ]
    .map((entry) => ({ ...entry, value: normalizePhone(entry.value) }))
    .filter((entry): entry is { value: string; path: string } => Boolean(entry.value));
  const phoneCandidates = uniqueCandidates("phone", phoneValues, (value) => value);

  const rawEmails = collectStringFields(input.raw, (key, value) => /email/i.test(key) || value.includes("@"));
  const emailValues = [
    ...(input.email ? [{ value: input.email, path: "$.captured.email" }] : []),
    ...rawEmails,
  ].filter((entry) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.value.trim()));
  const emailCandidates = uniqueCandidates("email", emailValues, (value) => value.toLowerCase());

  const startRaw = candidateDate(input.attributes, input.raw, ["start_date", "starts_at", "date"]);
  const endRaw = candidateDate(input.attributes, input.raw, ["end_date", "ends_at"]);
  let start = strictDate(startRaw);
  let end = strictDate(endRaw);
  if (startRaw && !start) warnings.push("invalid_source_start_date");
  if (endRaw && !end) warnings.push("invalid_source_end_date");
  if (start && end && compareIso(start.iso, end.iso) > 0) {
    warnings.push("reversed_source_date_range");
    start = null;
    end = null;
  }

  const countryCode =
    (input.country_code && /^[A-Za-z]{2}$/.test(input.country_code)
      ? input.country_code.toUpperCase()
      : countryToCode(input.country_code) ??
        countryToCode(stringValue(input.attributes.country_name)) ??
        countryToCode(input.region)) ?? null;

  return {
    normalizedName: input.name?.trim() || null,
    countryCode,
    phone: phoneCandidates[0]?.value ?? null,
    websiteDomain: websiteDomain(input.website),
    startDate: start?.iso ?? null,
    endDate: end?.iso ?? null,
    datePrecision: start?.precision ?? null,
    lat,
    lng,
    coordinateSource,
    coordinatePrecision: lat !== null && lng !== null ? "point" : null,
    urlCandidates,
    phoneCandidates,
    emailCandidates,
    coordinateCandidates,
    hardIsPoi:
      input.sourceIsPoiHint === false ||
      rawRecord.is_poi === false ||
      rawRecord.isPoi === false ||
      rawRecord.is_festival === false ||
      (typeof rawRecord.FacilityTypeDescription === "string" &&
        rawRecord.FacilityTypeDescription.toLowerCase() !== "campground")
        ? false
        : null,
    warnings,
  };
}

export function deterministicFingerprint(facts: DeterministicFacts): string {
  return stableHash(facts);
}
