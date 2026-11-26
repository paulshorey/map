import { pathToFileURL } from "node:url";
/** Collect source and listed-text coordinates plus administrative evidence with versioned provenance.
 * Valid source points never move. Missing country, region and city for a point come from the
 * offline gazetteer (offline-reverse.ts); only forward lookups call the provider.
 * Forward misses are cached and reported; transport/auth failures retain provider recovery.
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import {
  deriveForwardPrecision,
  storedPrecisionEvidence,
} from "../../lib/ingestion/geocode-precision.js";
import {
  geocode,
  GeocodeError,
  type GeocodeHit,
} from "./providers/locationiq.js";
import { artifactTransaction, fencedTransaction } from "./execution.js";
import { canonicalLane } from "./concurrency.js";
import { CANONICAL_WRITER_LOCK } from "../../lib/ingestion/locks.js";
import { rebuildCanonicalPoi } from "./merge.js";
import {
  LOCATION_VERSION,
  LOCATION_CACHE_VERSION,
  LOCATION_GEOCODER_VERSION,
  LOCATION_QUERY_VERSION,
  LOCALITY_CONFLICT_M,
  capLocalityPrecision,
  foldTokens,
  forwardImplausible,
  forwardLocalityConflict,
  forwardResultName,
  localityValue,
  locationReadySql,
  MUSICBRAINZ_VENUE_POLICY,
  providerNameAgrees,
  resolveLocation,
  resultNamesListedCity,
  textValue,
  reverseForPrecision,
  type ReverseLocation,
} from "./location.js";
import countries from "i18n-iso-countries";
import { countryToCode } from "./normalize/country.js";
import { suppliedCountryCentroid } from "./supplied-centroids.js";
import { offlineReverse } from "./offline-reverse.js";
import { recordLocations, writeRecordLocations } from "./record-locations.js";
import { stableHash } from "./hash.js";
import { assertNoOutdatedSources } from "./staleness.js";
import {
  ProviderQuotaExhausted,
  useProviderQuotaLedger,
} from "./providers/quota.js";
import { haversineMeters } from "./match/geo.js";
import {
  validPoint,
  type CoordinateEvidence,
  type MapLocation,
} from "../../lib/ingestion/location-points.js";

const DEFAULT_GEOCODE_LIMIT = 4500;
const DEFAULT_THROTTLE_MS = 1000; // LocationIQ free tier: stay comfortably under 2 req/s.

export interface CliOptions {
  recordId?: string;
  runId?: string;
  source?: string;
  limit?: number;
  // Undefined means no call cap for managed runs; standalone CLI retains its default.
  geocodeLimit?: number;
  throttleMs: number;
  dryRun: boolean;
}

interface GeocodeStats {
  selected: number;
  cacheHits: number;
  knownMisses: number;
  apiCalls: number;
  resolved: number;
  unresolved: number;
  noQuery: number;
  budgetHit: boolean;
  /** Set when the daily provider quota stopped lookups (resume after `resets_at`). */
  quota?: ReturnType<ProviderQuotaExhausted["toJSON"]>;
}

interface GeoRow {
  id: string;
  name: string | null;
  venue: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  country_name: string | null;
  category_slugs: string[] | null;
  lat?: number | null;
  lng?: number | null;
  coordinate_source?: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let limit: number | undefined;
  let geocodeLimit = DEFAULT_GEOCODE_LIMIT;
  let throttleMs = DEFAULT_THROTTLE_MS;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (a === "--geocode-limit" && argv[i + 1])
      geocodeLimit = Number(argv[++i]);
    else if (a === "--throttle-ms" && argv[i + 1])
      throttleMs = Number(argv[++i]);
  }

  for (const [name, val] of [
    ["--limit", limit],
    ["--geocode-limit", geocodeLimit],
    ["--throttle-ms", throttleMs],
  ] as const) {
    if (val !== undefined && (!Number.isFinite(val) || val < 0)) {
      throw new Error(`Invalid ${name}: ${val}`);
    }
  }

  return { source, limit, geocodeLimit, throttleMs, dryRun };
}

async function resolveSourceId(db: Pool, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM research_sources WHERE slug = $1`,
    [slug],
  );
  if (rows.length === 0) throw new Error(`Unknown source slug: ${slug}`);
  return rows[0]!.id;
}

/**
 * Build the geocode query text + a normalized cache key from a row's locality.
 * Optimistic (product decision): any of venue/address/city/region/country is
 * enough to attempt a lookup; everything available goes into the query.
 *
 * Event records (temporal categories) are geocoded by locality only — an event
 * *name* ("Cayman Batabano 2026") is not a place name and steers the geocoder
 * to wrong matches. Place records (gardens, campgrounds) keep the name: it IS
 * the place name and is often the only usable signal (e.g. ArbNet).
 */
/**
 * LocationIQ answers HTTP 400 "Invalid Request" for queries over about 200 UTF-8 bytes: a
 * 188-character Cyrillic address is 280 bytes. Lengths are measured in bytes.
 */
export const MAX_QUERY_BYTES = 190;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * Keep the most local, structured end of an over-long query: drop leading comma-separated
 * parts (institution and department names) until it fits, so the street, city, region and
 * country remain ("Departamento de Botánica…, Km 15.5 carr. …, Zapopan, Jalisco, Mexico").
 */
export function fitQueryLength(display: string): string {
  if (bytes(display) <= MAX_QUERY_BYTES) return display;
  const parts = display.split(/\s*,\s*/);
  while (parts.length > 1 && bytes(parts.join(", ")) > MAX_QUERY_BYTES)
    parts.shift();
  let fitted = parts.join(", ");
  // A single over-long part: keep its end, starting at a word boundary.
  while (bytes(fitted) > MAX_QUERY_BYTES) {
    const space = fitted.indexOf(" ");
    // Whole code points only: never leave half a surrogate pair.
    fitted =
      space === -1
        ? Array.from(fitted).slice(1).join("")
        : fitted.slice(space + 1);
  }
  return fitted;
}

export function buildQuery(
  row: GeoRow,
  temporalSlugs: Set<string>,
): { display: string; norm: string } | null {
  if (/^q\d+$/i.test(row.name?.trim() ?? "")) return null;
  const isEvent = (row.category_slugs ?? []).some((s) => temporalSlugs.has(s));
  const locality = [
    row.venue,
    row.address,
    row.city,
    row.region,
    row.country_name ?? row.country_code,
  ]
    .map((p) => (p ? p.trim() : ""))
    .filter((p) => p.length > 0);

  // Locality-only for events; name + locality for places. A record with no
  // locality at all falls back to its name either way (optimistic).
  const parts =
    isEvent && locality.length > 0
      ? locality
      : [row.name?.trim() ?? "", ...locality].filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const display = fitQueryLength(parts.join(", "));
  const norm = display
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (/^q\d+(,|$)/i.test(norm)) return null;
  return { display, norm };
}

/** The listed country's English name, for a fallback after an implausible lookup. */
export function countryOnlyQuery(code: string) {
  const display = countries.getName(code, "en");
  if (!display) return null;
  const norm = display
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { display, norm };
}

/** Listed fields a reverse lookup can supply at each point precision (see reverseForPrecision). */
const REVERSE_FIELDS: Record<
  string,
  Array<"country_code" | "region" | "city">
> = {
  point: ["country_code", "region", "city"],
  city: ["country_code", "region", "city"],
  unknown: ["country_code", "region", "city"],
  region: ["country_code", "region"],
  country: ["country_code"],
};

/** A street address supplied by the listing itself, never a location hint label. */
function capturedStreetAddress(captured: Record<string, any>): string | null {
  const attrs = captured.attributes ?? {};
  return (
    localityValue(captured.address) ??
    localityValue(attrs.venue_address) ??
    localityValue(attrs.street_address)
  );
}

/** Captured listing text for lookup; placeholder locality such as "Various venues" is dropped. */
export function listedLocality(row: GeoRow, captured: Record<string, any>) {
  const attrs = captured.attributes ?? {};
  const hints = attrs.source_location_hints ?? {};
  return {
    ...row,
    name: textValue(captured.name),
    venue:
      localityValue(attrs.venue) ??
      localityValue(attrs.venue_name) ??
      localityValue(hints.venue),
    address:
      localityValue(captured.address) ??
      localityValue(attrs.venue_address) ??
      localityValue(attrs.street_address) ??
      localityValue(hints.location),
    city: localityValue(captured.city) ?? localityValue(hints.city),
    region: localityValue(captured.region) ?? localityValue(hints.region),
    country_code: textValue(captured.country_code),
    country_name: textValue(attrs.country_name) ?? textValue(hints.country),
  };
}

const STREET_SUFFIXES = new Map([
  ["ST", "STREET"],
  ["RD", "ROAD"],
  ["AVE", "AVENUE"],
  ["BLVD", "BOULEVARD"],
  ["DR", "DRIVE"],
  ["LN", "LANE"],
  ["HWY", "HIGHWAY"],
]);
const STREET_TYPES = new Set(STREET_SUFFIXES.values());
const STREET_DIRECTIONS = new Map([
  ["NORTH", "N"],
  ["SOUTH", "S"],
  ["EAST", "E"],
  ["WEST", "W"],
]);
const HOUSE_NUMBER = String.raw`\d+[a-z]?(?:[-/–−]\d+[a-z]?)*`;
const STANDALONE_HOUSE_NUMBER = new RegExp(`^${HOUSE_NUMBER}$`, "u");
const POSTCODE_SHAPE = /^(?:\d{4,}|\d{2}[-–−]\d{3}|\d{3}[-–−]\d{4}|\d{5}[-–−]\d{3,4})$/u;
const LEADING_HOUSE_NUMBER = new RegExp(
  String.raw`^(${HOUSE_NUMBER})\s+(\p{L}.*)$`,
  "u",
);
const TRAILING_HOUSE_NUMBER = new RegExp(
  String.raw`^(\p{L}.*?)\s+(${HOUSE_NUMBER})$`,
  "u",
);
const NUMBERED_PREMISES =
  /^(?:building|floor|hall|pier|room|stage|suite|unit)\s+\d/u;

function streetName(value: string) {
  const tokens = foldTokens(value);
  const last = tokens.at(-1);
  const direction =
    last && (STREET_DIRECTIONS.has(last) || /^[NSEW]$/.test(last))
      ? STREET_DIRECTIONS.get(last) ?? last
      : undefined;
  const suffixIndex = tokens.length - (direction ? 2 : 1);
  const suffix = tokens[suffixIndex];
  if (suffix) tokens[suffixIndex] = STREET_SUFFIXES.get(suffix) ?? suffix;
  if (direction) tokens[tokens.length - 1] = direction;
  const first = tokens[0];
  // Keep "East Street" distinct from the letter-named street "E Street".
  if (first && suffixIndex > 1) tokens[0] = STREET_DIRECTIONS.get(first) ?? first;
  return tokens.join(" ");
}

function houseNumberKey(value: string) {
  return value.normalize("NFKC").toLowerCase().replace(/[–−]/g, "-");
}

function streetAddressLine(
  address: string,
  listedCity: string | null,
  providerRoad: string | null,
  providerPostcode: string | null,
  providerHouseNumber: string | undefined,
) {
  const parts = address.split(",", 3).map((part) => part.trim());
  // A venue or unit can be listed before its street address, e.g. "Pier 17, 89 South St".
  const [line = "", adjacent = ""] = NUMBERED_PREMISES.test(parts[0] ?? "")
    ? parts.slice(1)
    : parts;
  // A postcode-shaped segment is ambiguous. Accept it when the provider
  // reports that same house number and does not identify it as a postcode.
  // Existing attached house numbers take precedence.
  if (
    /^\p{L}/u.test(line) &&
    STANDALONE_HOUSE_NUMBER.test(adjacent) &&
    (!POSTCODE_SHAPE.test(adjacent) ||
      houseNumberKey(adjacent) === providerHouseNumber) &&
    (!providerPostcode ||
      houseNumberKey(adjacent) !== houseNumberKey(providerPostcode)) &&
    !LEADING_HOUSE_NUMBER.test(line) &&
    !TRAILING_HOUSE_NUMBER.test(line)
  )
    return `${line} ${adjacent}`;
  const city = listedCity
    ?.split(",")[0]
    ?.trim()
    .normalize("NFKC")
    .toLowerCase();
  if (!city) return line;
  const cityStart = line.lastIndexOf(` ${city}`);
  const cityEnd = cityStart + city.length + 1;
  if (cityStart <= 0 || (cityEnd < line.length && line[cityEnd] !== " "))
    return line;
  // A missing comma can put the city immediately after the street. Only trim a
  // recognizable street ending or a road independently named by the provider.
  const beforeCity = line
    .slice(0, cityStart)
    .replace(/\s+(?:ste|suite|unit)\s+\d+[a-z]?$/, "");
  const road = beforeCity.replace(/^\d+[a-z]?(?:[-/–−]\d+[a-z]?)*\s+/, "");
  const normalizedRoad = streetName(road);
  const roadTokens = normalizedRoad.split(" ");
  const last = roadTokens.at(-1);
  const roadType = last && /^[NSEW]$/.test(last) ? roadTokens.at(-2) : last;
  const recognizedStreet =
    (roadType && STREET_TYPES.has(roadType)) ||
    (providerRoad && streetName(providerRoad) === normalizedRoad);
  return recognizedStreet ? beforeCity : line;
}

function linkedVenueNameAgrees(
  venue: string | null,
  raw: GeocodeHit["raw_response"],
) {
  const providerName = forwardResultName(raw);
  if (!venue || !providerName) return false;
  const shortName = (value: string) =>
    foldTokens(value).join(" ").replace(/^THE /, "");
  // A venue can use a short name ("The Meteor") for a theatre mapped as "Meteor Theatre".
  const theatreName = providerName.replace(/\s+theat(?:re|er)$/i, "");
  return [providerName, theatreName].some(
    (name) =>
      shortName(name) === shortName(venue) && providerNameAgrees(venue, name),
  );
}

/** A linked venue needs corroboration, even when the provider describes the result as a point. */
export function musicBrainzVenueResultIssue(
  listed: {
    address: string;
    venue: string | null;
    city: string | null;
    country_code?: string | null;
  },
  hit: Pick<GeocodeHit, "precision" | "raw_response" | "city" | "country_code">,
) {
  const unconfirmed = "venue_address_unconfirmed";
  if (hit.precision !== "point" || hit.raw_response?.class === "highway")
    return unconfirmed;
  const result = hit.raw_response?.address as
    | Record<string, unknown>
    | undefined;
  const country = countryToCode(
    hit.country_code ?? textValue(result?.country_code),
  );
  if (listed.country_code && country && listed.country_code !== country)
    return "venue_country_mismatch";
  const address = listed.address.normalize("NFKC").toLowerCase();
  const road = textValue(result?.road);
  const houseNumber = textValue(result?.house_number);
  const numberKey = houseNumber ? houseNumberKey(houseNumber) : undefined;
  const street = streetAddressLine(
    address,
    listed.city,
    road,
    textValue(result?.postcode),
    numberKey,
  );
  const leading = LEADING_HOUSE_NUMBER.exec(street);
  const trailing = TRAILING_HOUSE_NUMBER.exec(street);
  const listedNumber = leading?.[1] ?? trailing?.[2];
  const listedRoad = leading?.[2] ?? trailing?.[1];
  const roadMatches =
    !!road && !!listedRoad && streetName(listedRoad) === streetName(road);
  const venueMatches = linkedVenueNameAgrees(listed.venue, hit.raw_response);
  const range = /^(\d+)([-–])(\d+)$/.exec(listedNumber ?? "");
  // A dash can express a range or an indivisible number (e.g. 52-19 Flushing Ave).
  // Endpoints of a plain hyphenated range require the named venue on the same road.
  const rangeEndpoint =
    range &&
    Number(range[1]) < Number(range[3]) &&
    (range[2] === "–" || (venueMatches && roadMatches)) &&
    (numberKey === range[1] || numberKey === range[3]);
  const houseMatches =
    !!listedNumber &&
    !!numberKey &&
    (houseNumberKey(listedNumber) === numberKey || rangeEndpoint);
  if (listedNumber && numberKey && !houseMatches)
    return "venue_house_number_mismatch";
  if (listedRoad && road && !roadMatches) return "venue_road_mismatch";
  if (roadMatches && houseMatches) return null;

  if (!venueMatches) return unconfirmed;
  // A namesake with no address agreement needs both a comparable listed address
  // and an explicit city match. For other address formats require a matching road.
  if (roadMatches) return null;
  const city = localityValue(listed.city);
  const cityName = city ? foldTokens(city.split(",")[0]!).join(" ") : "";
  // A venue can be returned under a central district, with the enclosing
  // city in the provider's county field. Require both labels and the country.
  const centralDistrictAndCity =
    !!cityName &&
    !!country &&
    country === listed.country_code &&
    foldTokens(textValue(result?.city) ?? "").join(" ") ===
      `${cityName} CENTRAL` &&
    foldTokens(textValue(result?.county) ?? "").join(" ") === `${cityName} CITY`;
  if (!centralDistrictAndCity && resultNamesListedCity(listed.city, hit) !== true)
    return unconfirmed;
  const roadTokens = road ? foldTokens(road).join(" ") : "";
  const addressContainsRoad =
    roadTokens &&
    ` ${foldTokens(address).join(" ")} `.includes(` ${roadTokens} `);
  return listedNumber || addressContainsRoad ? null : unconfirmed;
}

/** The address candidate must be independent of reverse enrichment and LLM guesses. */
export function listedQuery(
  row: GeoRow,
  captured: Record<string, any>,
  temporal: Set<string>,
) {
  const queryRow = listedLocality(row, captured);
  if (
    validPoint(row) &&
    ![
      queryRow.venue,
      queryRow.address,
      queryRow.city,
      queryRow.region,
      queryRow.country_code,
      queryRow.country_name,
    ].some(Boolean)
  )
    return null;
  // Multiple venue names can steer free-form lookup to an unrelated business.
  // A supplied address/locality is the better query when available.
  const q = buildQuery(
    queryRow.address ? { ...queryRow, name: null, venue: null } : queryRow,
    temporal,
  );
  // A country-only lookup beside a supplied point adds a centroid marker, not evidence.
  const country = (queryRow.country_name ?? queryRow.country_code)?.trim();
  if (
    q &&
    validPoint(row) &&
    ["source", "url"].includes(row.coordinate_source ?? "") &&
    country &&
    q.display === country
  )
    return null;
  return q;
}

export type QueryBasis = "address" | "venue" | "name" | "locality";

/**
 * `fitQueryLength` may drop the address, venue or name from an over-long query; the basis is
 * then what survived (normally the locality), so locality guards still apply to the result.
 */
export function basisAfterFit(
  basis: QueryBasis,
  listed: {
    address?: string | null;
    venue?: string | null;
    name?: string | null;
    city?: string | null;
    region?: string | null;
    country_name?: string | null;
    country_code?: string | null;
  },
  display: string,
): QueryBasis {
  // A component survives only through a part of its own that is still in the query and is
  // not just the listed locality: "…, Rue X, Paris" trimmed to "Paris" is locality text.
  const fold = (t: string) => t.trim().toLowerCase();
  const kept = new Set(display.split(/\s*,\s*/).map(fold));
  // Same comma parts as the query: "Paris, Île-de-France" contributes "paris".
  const locality = new Set(
    [listed.city, listed.region, listed.country_name, listed.country_code]
      .filter((t): t is string => !!t)
      .flatMap((t) => t.split(/\s*,\s*/))
      .map(fold)
      .filter(Boolean),
  );
  // The first kept part may be the trimmed tail of a single over-long component.
  const head = [...kept][0] ?? "";
  const survives = (text: string | null | undefined) =>
    !!text &&
    text
      .split(/\s*,\s*/)
      .map(fold)
      .some(
        (part) =>
          !!part &&
          !locality.has(part) &&
          (kept.has(part) ||
            (head.length >= 8 && !locality.has(head) && part.endsWith(head))),
      );
  if (basis === "address" && !survives(listed.address))
    return survives(listed.venue)
      ? "venue"
      : survives(listed.name)
        ? "name"
        : "locality";
  if (basis === "venue" && !survives(listed.venue))
    return survives(listed.name) ? "name" : "locality";
  if (basis === "name" && !survives(listed.name)) return "locality";
  return basis;
}

/** The most specific listing text in `listedQuery`'s lookup. `locality` means only
 * city/region/country text, so its result is a general location, never a venue or address. */
export function listedQueryBasis(
  row: GeoRow,
  captured: Record<string, any>,
  temporal: Set<string>,
): QueryBasis {
  const r = listedLocality(row, captured);
  // An address slot filled only by `hints.location` (a listing label such as "Melbourne, VIC")
  // drops the name and venue, so that lookup is locality text, not a street address.
  if (r.address)
    return capturedStreetAddress(captured) ? "address" : "locality";
  if (r.venue) return "venue";
  const isEvent = (row.category_slugs ?? []).some((s) => temporal.has(s));
  const locality = [r.city, r.region, r.country_name ?? r.country_code].some(
    Boolean,
  );
  // buildQuery adds the name for places, and for events only when nothing else is listed.
  return r.name && (!isEvent || !locality) ? "name" : "locality";
}

/** Locality-only retry when a venue/address lookup lands in another city. */
export function listedCityQuery(
  row: GeoRow,
  captured: Record<string, any>,
  temporal: Set<string>,
) {
  const queryRow = listedLocality(row, captured);
  if (!queryRow.city) return null;
  return buildQuery(
    { ...queryRow, name: null, venue: null, address: null },
    temporal,
  );
}

export const forwardCacheKey = (norm: string, country: string | null) =>
  `${LOCATION_CACHE_VERSION}:forward:${LOCATION_QUERY_VERSION}:${country ?? "any"}:${norm}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readCache(
  db: Pool,
  norm: string,
): Promise<
  | {
      lat: number | null;
      lng: number | null;
      precision: GeocodeHit["precision"] | null;
      payload?: { hit?: GeocodeHit | null };
    }
  | undefined
> {
  const { rows } = await db.query<{
    lat: number | null;
    lng: number | null;
    precision: GeocodeHit["precision"] | null;
    payload?: { hit?: GeocodeHit | null };
  }>(
    `SELECT lat, lng, precision, payload FROM research_geocode_cache WHERE query_norm = $1`,
    [norm],
  );
  return rows[0];
}

async function writeCache(
  db: Pool,
  norm: string,
  hit: GeocodeHit | null,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    `INSERT INTO research_geocode_cache (query_norm, lat, lng, precision, provider, payload)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (query_norm) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       precision = EXCLUDED.precision, provider = EXCLUDED.provider, payload = EXCLUDED.payload,
       fetched_at = now()`,
    [
      norm,
      hit?.lat ?? null,
      hit?.lng ?? null,
      hit?.precision ?? null,
      hit?.provider ?? "locationiq",
      JSON.stringify({ hit, ...extra }),
    ],
  );
}

export async function writeRowCoords(
  db: Pool,
  id: string,
  lat: number,
  lng: number,
  precision: GeocodeHit["precision"],
  queryNorm: string,
): Promise<void> {
  const inputHash = stableHash({
    queryNorm,
    provider: "locationiq",
    version: "locationiq-v1",
  });
  const linked = (
    await db.query("SELECT canonical_poi_id FROM research_pois WHERE id=$1", [
      id,
    ])
  ).rows[0]?.canonical_poi_id;
  const activate = () =>
    artifactTransaction(db, async (client) => {
      if (linked)
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
          CANONICAL_WRITER_LOCK,
        ]);
      const { rows } = await client.query(
        `WITH artifact AS (
       INSERT INTO research_poi_geocodes (
       normalization_id, input_hash, query_norm, provider, provider_version,
       lat, lng, precision, status, activated_at
       )
       SELECT active_normalization_id, $2, $3, 'locationiq', 'locationiq-v1',
              $4, $5, $6, 'resolved', now()
       FROM research_pois
       WHERE id = $1 AND active_normalization_id IS NOT NULL
       ON CONFLICT (normalization_id, input_hash) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, precision = EXCLUDED.precision,
       status = EXCLUDED.status, activated_at = now()
       RETURNING id
     )
     UPDATE research_pois SET
       lat = $4, lng = $5, coordinate_source = 'geocode', coordinate_precision = $6,
       geocode_query_norm = $3,
       active_geocode_id = (SELECT id FROM artifact)
     WHERE id = $1 RETURNING active_geocode_id,canonical_poi_id`,
        [id, inputHash, queryNorm, lat, lng, precision],
      );
      if (rows[0]?.canonical_poi_id) {
        if (!linked)
          throw Object.assign(
            new Error("Canonical link changed during artifact activation"),
            { code: "lineage_invalid" },
          );
        await rebuildCanonicalPoi(client, rows[0].canonical_poi_id, {
          noLlm: true,
        });
      }
      return {
        value: undefined,
        output: { status: "succeeded", geocode_id: rows[0].active_geocode_id },
      };
    });
  await (linked ? canonicalLane.run(activate) : activate());
}

/** Record why a record has no plausible point (shown by location review); nothing else changes. */
async function recordUnlocated(
  db: Pool,
  researchId: string,
  evidence: Record<string, unknown>,
) {
  await fencedTransaction(db, (client) =>
    client.query(
      `UPDATE research_pois SET attributes=COALESCE(attributes,'{}'::jsonb)
        || jsonb_build_object('location_unresolved',$2::jsonb) WHERE id=$1`,
      [researchId, JSON.stringify(evidence)],
    ),
  );
}

/** Collect an independent listed-location candidate, then source-first reverse enrichment. */
export async function runGeocode(
  db: Pool,
  opts: CliOptions,
): Promise<GeocodeStats> {
  const stats: GeocodeStats = {
    selected: 0,
    cacheHits: 0,
    knownMisses: 0,
    apiCalls: 0,
    resolved: 0,
    unresolved: 0,
    noQuery: 0,
    budgetHit: false,
  };
  const params: unknown[] = [];
  let where =
    "rp.is_poi AND rp.retired_at IS NULL AND rp.active_normalization_id IS NOT NULL";
  if (opts.source) {
    params.push(await resolveSourceId(db, opts.source));
    where += ` AND rp.source_id=$${params.length}`;
  }
  if (opts.recordId) {
    params.push(opts.recordId);
    where += ` AND rp.id=$${params.length}`;
  }
  where += ` AND NOT COALESCE(${locationReadySql()},false)`;
  if (opts.limit !== undefined) params.push(opts.limit);
  const rows = (
    await db.query(
      `SELECT rp.id,rs.slug AS source_slug FROM research_pois rp JOIN research_sources rs ON rs.id=rp.source_id WHERE ${where} ORDER BY rp.first_seen_at${opts.limit !== undefined ? ` LIMIT $${params.length}` : ""}`,
      params,
    )
  ).rows;
  stats.selected = rows.length;
  for (const selected of rows) {
    const remaining = () =>
      opts.geocodeLimit === undefined
        ? undefined
        : Math.max(0, opts.geocodeLimit - stats.apiCalls);
    const row = (
      await db.query(
        `SELECT rp.*,o.captured
      FROM research_pois rp JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id JOIN research_poi_observations o ON o.id=rp.active_observation_id WHERE rp.id=$1`,
        [selected.id],
      )
    ).rows[0];
    const captured = row.captured ?? {},
      attrs = captured.attributes ?? {};
    const linkedMusicBrainzVenue =
      selected.source_slug === "musicbrainz" && Boolean(attrs.musicbrainz_venue_mbid);
    const venuePolicy = linkedMusicBrainzVenue
      ? { musicbrainz_venue_policy: MUSICBRAINZ_VENUE_POLICY }
      : {};
    const source = {
      country_code:
        countryToCode(captured.country_code) ??
        countryToCode(attrs.country_name) ??
        null,
      // Filler such as "Various" stays in the capture but never becomes the projected locality.
      address:
        localityValue(captured.address) ??
        localityValue(attrs.venue_address) ??
        localityValue(attrs.street_address),
      city: localityValue(captured.city),
      region: localityValue(captured.region),
    };
    let lat: number | null = row.lat,
      lng: number | null = row.lng;
    let coordinateSource = row.coordinate_source,
      coordinatePrecision = row.coordinate_precision;
    const previousLocation = row.attributes?.location_enrichment;
    const previousForward = previousLocation?.forward;
    const recheckingVenue =
      linkedMusicBrainzVenue &&
      coordinateSource === "geocode" &&
      previousLocation?.normalization_id === row.active_normalization_id &&
      previousLocation?.point?.lat === lat &&
      previousLocation?.point?.lng === lng &&
      previousForward?.rejected?.reason === "venue_address_unconfirmed";
    const venueFallback =
      recheckingVenue &&
      previousForward.query_basis === "locality" &&
      previousForward.result?.lat === lat &&
      previousForward.result?.lng === lng &&
      previousForward.result?.precision === coordinatePrecision
        ? previousForward
        : null;
    // A supplied point that repeats a published country centroid locates only the country.
    // The listed country may live only in location hints (thatfestivalsite), as for lookups.
    const listedCountry =
      source.country_code ??
      countryToCode(textValue(attrs.source_location_hints?.country)) ??
      null;
    const suppliedCentroid = ["source", "url"].includes(row.coordinate_source)
      ? suppliedCountryCentroid(row, listedCountry)
      : null;
    if (suppliedCentroid) coordinatePrecision = "country";
    const temporal = new Set<string>(
      (
        await db.query(
          "SELECT slug FROM canonical_categories WHERE is_temporal",
        )
      ).rows.map((r) => r.slug),
    );
    const q = listedQuery(row, captured, temporal);
    const forwardCountry = listedCountry;
    // Separate policy namespace; do not reuse historical name/reverse-derived queries.
    const lookup = async (query: { display: string; norm: string }) => {
      const key = forwardCacheKey(query.norm, forwardCountry);
      const cached = await readCache(db, key);
      if (cached) {
        stats.cacheHits++;
        const hit: GeocodeHit | null = validPoint(cached)
          ? {
              ...cached.payload?.hit,
              lat: cached.lat!,
              lng: cached.lng!,
              precision: cached.precision ?? "point",
              provider: "locationiq",
            }
          : null;
        if (
          (cached.payload as { invalid_request?: boolean } | undefined)
            ?.invalid_request
        )
          invalidQueries.push(query.display);
        if (!hit) stats.knownMisses++;
        else if (hit.raw_response) {
          // The saved provider row reproduces the current classifier without a paid refetch.
          hit.precision_evidence = deriveForwardPrecision(hit.raw_response);
          hit.precision = hit.precision_evidence
            .value as GeocodeHit["precision"];
        } else
          hit.precision_evidence = storedPrecisionEvidence(hit, "legacy_cache");
        return { key, hit, stop: null };
      }
      if (remaining() === 0) return { key, hit: null, stop: "budget" as const };
      if (opts.dryRun) {
        stats.apiCalls++;
        return { key, hit: null, stop: "dry_run" as const };
      }
      if (opts.throttleMs > 0) await sleep(opts.throttleMs);
      let hit: GeocodeHit | null;
      try {
        hit = await geocode(query.display, forwardCountry);
      } catch (error) {
        // The daily quota is a budget stop: nothing is cached or settled, and the record
        // stays pending for the resume after the reset.
        if (error instanceof ProviderQuotaExhausted) {
          stats.quota = error.toJSON();
          return { key, hit: null, stop: "budget" as const };
        }
        // "Invalid Request" is about this query, not the provider: treat it as an uncached
        // miss so the fallback chain continues and one record cannot stop a whole file.
        if (
          error instanceof GeocodeError &&
          (error as { status?: number }).status === 400
        ) {
          stats.apiCalls++;
          invalidQueries.push(query.display);
          // Deterministic for this query: remember it so a resume continues at the fallback.
          await writeCache(db, key, null, { invalid_request: true });
          return { key, hit: null, stop: null };
        }
        throw error;
      }
      stats.apiCalls++;
      await writeCache(db, key, hit);
      return { key, hit, stop: null };
    };
    let forward: GeocodeHit | null = null;
    let forwardQueryNorm: string | null = null;
    let forwardQuery = q;
    let forwardBasis: QueryBasis | null = q
      ? basisAfterFit(
          listedQueryBasis(row, captured, temporal),
          listedLocality(row, captured),
          q.display,
        )
      : null;
    let rejected: Record<string, unknown> | null = null;
    let fallbackFrom: { reason: string; query: string } | null = null;
    const invalidQueries: string[] = [];
    let cityConfirmation: {
      query: string;
      query_norm: string;
      result: GeocodeHit;
    } | null = null;
    if (q) {
      const first = await lookup(q);
      if (first.stop === "budget") {
        stats.budgetHit = true;
        break;
      }
      if (first.stop) continue;
      forwardQueryNorm = first.key;
      forward = first.hit ?? null;
      if (
        linkedMusicBrainzVenue &&
        source.address &&
        forwardBasis === "address"
      ) {
        const venue = localityValue(attrs.musicbrainz_venue_name);
        const listedVenue = { ...source, address: source.address, venue };
        const mismatch =
          forward && musicBrainzVenueResultIssue(listedVenue, forward);
        if (mismatch) {
          rejected = {
            reason: mismatch,
            query: q.display,
            query_norm: first.key,
            result: forward,
          };
          forward = null;
        }
        // A numbered unit may resolve to a different building on the same street.
        // Try the independently supplied held-at name before falling back to the city.
        if (!forward && venue && source.city) {
          const listed = {
            ...listedLocality(row, captured),
            name: null,
            address: null,
            venue,
          };
          const venueQuery = buildQuery(listed, temporal);
          if (
            venueQuery &&
            venueQuery.norm !== q.norm &&
            basisAfterFit("venue", listed, venueQuery.display) === "venue"
          ) {
            const retry = await lookup(venueQuery);
            if (retry.stop === "budget") {
              stats.budgetHit = true;
              break;
            }
            if (retry.stop) continue;
            forwardQuery = venueQuery;
            forwardQueryNorm = retry.key;
            forwardBasis = "venue";
            forward = retry.hit;
            if (forward) {
              const reason = musicBrainzVenueResultIssue(listedVenue, forward);
              if (reason) {
                rejected = {
                  reason,
                  query: venueQuery.display,
                  query_norm: retry.key,
                  result: forward,
                  previous: rejected,
                };
                forward = null;
              }
            }
          }
        }
      }
      const cityQuery = listedCityQuery(row, captured, temporal);
      const sourcePoint =
        !suppliedCentroid &&
        validPoint({ lat: row.lat, lng: row.lng }) &&
        ["source", "url"].includes(row.coordinate_source)
          ? { lat: row.lat as number, lng: row.lng as number }
          : null;
      if (
        forward &&
        cityQuery &&
        cityQuery.norm !== forwardQuery?.norm &&
        forwardLocalityConflict(
          listedLocality(row, captured).city,
          forward,
          sourcePoint,
        )
      ) {
        const retry = await lookup(cityQuery);
        if (retry.stop === "budget") {
          stats.budgetHit = true;
          break;
        }
        if (retry.stop) continue;
        // The listed city's own lookup confirms a nearby result (another spelling of that city).
        const confirmed =
          retry.hit &&
          haversineMeters(retry.hit, forward) <= LOCALITY_CONFLICT_M;
        if (confirmed && retry.hit) {
          cityConfirmation = {
            query: cityQuery.display,
            query_norm: retry.key,
            result: retry.hit,
          };
        } else {
          // Keep the rejected paid result as evidence; it never occupies the inferred slot.
          rejected = {
            reason: "forward_locality_conflict",
            query: forwardQuery?.display ?? q.display,
            query_norm: forwardQueryNorm,
            result: forward,
            ...(rejected ? { previous: rejected } : {}),
          };
          forwardQuery = cityQuery;
          forwardBasis = "locality";
          forwardQueryNorm = retry.key;
          forward = retry.hit ?? null;
        }
      }
      const implausible =
        forward &&
        forwardImplausible(
          forwardBasis,
          listedLocality(row, captured),
          forward,
        );
      if (forward && implausible) {
        // Keep the paid result as evidence; it never occupies the inferred slot.
        const current = {
          reason: implausible,
          query: forwardQuery?.display ?? q.display,
          query_norm: forwardQueryNorm,
          result: forward,
        };
        rejected = rejected ? { ...current, previous: rejected } : current;
        forward = null;
      }
      // A namesake can still fail the updated venue check. Retain the accepted
      // locality hit bound to this record instead of erasing its inferred evidence.
      if (!forward && venueFallback) {
        const localityQuery = [
          cityQuery,
          forwardCountry ? countryOnlyQuery(forwardCountry) : null,
        ].find(
          (query) => query && forwardCacheKey(query.norm, forwardCountry) === venueFallback.query_norm,
        );
        if (localityQuery) {
          forward = venueFallback.result;
          forwardBasis = "locality";
          forwardQuery = localityQuery;
          forwardQueryNorm = venueFallback.query_norm;
          fallbackFrom = venueFallback.fallback_from ?? null;
        }
      }
      // No plausible result and no point at all: fall back to the listed city, then the
      // recognized country, so the record still publishes as a general location. A record
      // with a supplied or retained point keeps it.
      if (!forward && !validPoint({ lat, lng })) {
        const tried = new Set([q.norm, forwardQuery?.norm]);
        const listed = listedLocality(row, captured);
        const steps = [
          { query: listedCityQuery(row, captured, temporal), listed },
          {
            query: forwardCountry ? countryOnlyQuery(forwardCountry) : null,
            listed: { city: null },
          },
        ];
        let stop: "budget" | "other" | null = null;
        for (const step of steps) {
          if (!step.query || tried.has(step.query.norm)) continue;
          tried.add(step.query.norm);
          const retry = await lookup(step.query);
          if (retry.stop) {
            stop = retry.stop === "budget" ? "budget" : "other";
            break;
          }
          if (
            retry.hit &&
            !forwardImplausible("locality", step.listed, retry.hit)
          ) {
            fallbackFrom = {
              reason: rejected ? "rejected" : "miss",
              query: q.display,
            };
            forward = retry.hit;
            forwardQuery = step.query;
            forwardBasis = "locality";
            forwardQueryNorm = retry.key;
            break;
          }
        }
        if (stop === "budget") {
          stats.budgetHit = true;
          break;
        }
        if (stop) continue;
      }
      if (forward) forward = capLocalityPrecision(forwardBasis, forward);
    } else stats.noQuery++;
    // Only a confirmed venue or address can replace a previously inferred locality.
    const promotedVenue =
      recheckingVenue &&
      coordinatePrecision === "city" &&
      (forwardBasis === "venue" || forwardBasis === "address") &&
      forward?.precision === "point";
    if (!validPoint({ lat, lng }) || promotedVenue) {
      if (!forward) {
        stats.unresolved++;
        // Every lookup finished (budget/provider stops exit above): no plausible point exists.
        if (!opts.dryRun)
          await recordUnlocated(db, row.id, {
            version: LOCATION_VERSION,
            normalization_id: row.active_normalization_id,
            settled_at: new Date().toISOString(),
            forward: {
              query_version: LOCATION_QUERY_VERSION,
              country_filter: forwardCountry,
              query: forwardQuery?.display ?? null,
              query_basis: forwardBasis,
              query_norm: forwardQueryNorm,
              state: !q ? "no_query" : "unresolved",
              ...(rejected ? { rejected } : {}),
              ...(invalidQueries.length
                ? { invalid_queries: invalidQueries }
                : {}),
            },
          });
        continue;
      }
      lat = forward.lat;
      lng = forward.lng;
      coordinateSource = "geocode";
      coordinatePrecision = forward.precision;
    }
    if (opts.dryRun) continue;
    const coordinateEvidence: CoordinateEvidence = {
      source_coordinates:
        validPoint({ lat: row.lat, lng: row.lng }) &&
        ["source", "url"].includes(row.coordinate_source)
          ? {
              lat: row.lat,
              lng: row.lng,
              kind: "source",
              origin: "source_coordinates",
              precision: suppliedCentroid
                ? "country"
                : (row.coordinate_precision ?? "point"),
              label: null,
              query: null,
            }
          : null,
      inferred_coordinates: forward
        ? {
            lat: forward.lat,
            lng: forward.lng,
            kind: "inferred",
            origin: "listed_address_geocode",
            precision: forward.precision,
            label: forward.label ?? null,
            query: forwardQuery?.display ?? null,
            precision_evidence: forward.precision_evidence,
          }
        : null,
    };
    // Identifies the artifact's point; reverse lookups themselves are offline and uncached.
    const queryNorm = `${LOCATION_CACHE_VERSION}:reverse:${lat}:${lng}`;
    // Only fields the offline lookup may still supply at this precision justify it; a
    // centroid match already names its country. It never supplies a street address.
    const reverseNeeded = REVERSE_FIELDS[
      coordinatePrecision ?? "unknown"
    ]!.some(
      (key) =>
        !source[key] &&
        !(
          key === "country_code" &&
          suppliedCentroid &&
          countryToCode(suppliedCentroid)
        ),
    );
    // Offline gazetteer lookup: no provider call, quota or cache entry. It is free, so it
    // runs even when nothing is missing: it is the independent check that a complete
    // listing's point lies in the listed country and city. A country-precision point with
    // its country known says nothing more, so it is skipped.
    const hit: ReverseLocation | null =
      reverseNeeded || coordinatePrecision !== "country"
        ? offlineReverse(lat!, lng!)
        : null;
    const resolved = resolveLocation(
      source,
      reverseForPrecision(hit, coordinatePrecision),
    );
    if (
      forwardCountry &&
      forward?.country_code &&
      forwardCountry !== forward.country_code
    )
      resolved.warnings.push("forward_country_conflict");
    if (!hit && reverseNeeded)
      resolved.warnings.push("reverse_location_incomplete");
    // The matched centroid identifies the country when the listing names none.
    // Vendored codes include non-ISO entries (GZ, AN); only a current ISO code is projected.
    const centroidCountry = suppliedCentroid
      ? countryToCode(suppliedCentroid)
      : undefined;
    if (centroidCountry && !resolved.fields.country_code) {
      resolved.fields.country_code = centroidCountry;
      (resolved.provenance as Record<string, unknown>).country_code =
        "supplied_centroid";
    }
    if (suppliedCentroid)
      resolved.warnings.push("source_point_country_centroid");
    if (Object.values(resolved.fields).some((value) => !value))
      resolved.warnings.push("location_fields_incomplete");
    const metadata = {
      version: LOCATION_VERSION,
      ...venuePolicy,
      normalization_id: row.active_normalization_id,
      point: { lat, lng },
      forward_query_norm: forwardQueryNorm,
      listed: { ...source, hints: attrs.source_location_hints ?? null },
      forward: {
        query_version: LOCATION_QUERY_VERSION,
        country_filter: forwardCountry,
        query: forwardQuery?.display ?? null,
        query_basis: forwardBasis,
        query_norm: forwardQueryNorm,
        state: !q ? "no_query" : forward ? "resolved" : "miss",
        result: forward,
        ...(rejected ? { rejected } : {}),
        ...(cityConfirmation ? { city_confirmation: cityConfirmation } : {}),
        ...(fallbackFrom ? { fallback_from: fallbackFrom } : {}),
        ...(invalidQueries.length ? { invalid_queries: invalidQueries } : {}),
      },
      coordinate_evidence: coordinateEvidence,
      ...(suppliedCentroid
        ? {
            supplied_centroid: {
              country_code: suppliedCentroid,
              reference: "google-dspl-countries",
              match: "rounded_to_supplied_precision",
            },
          }
        : {}),
      ...resolved,
      reverse: hit,
      lookup_state: hit ? "resolved" : reverseNeeded ? "miss" : "not_needed",
      assessed_at: new Date().toISOString(),
    };
    const inputHash = stableHash({
      normalization: row.active_normalization_id,
      point: metadata.point,
      coordinate_source: coordinateSource,
      forward_query_norm: forwardQueryNorm,
      // Bind any newly captured response metadata to this artifact without changing query-cache identity.
      forward_result: forward,
      ...(rejected ? { forward_rejected: rejected } : {}),
      ...(cityConfirmation
        ? { forward_city_confirmation: cityConfirmation }
        : {}),
      version: LOCATION_VERSION,
      ...venuePolicy,
      coordinate_evidence: coordinateEvidence,
    });
    await canonicalLane.run(() =>
      artifactTransaction(db, async (client) => {
        if (row.canonical_poi_id)
          await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
            CANONICAL_WRITER_LOCK,
          ]);
        const artifact = (
          await client.query(
            `INSERT INTO research_poi_geocodes(normalization_id,input_hash,query_norm,provider,provider_version,lat,lng,precision,status,validation,activated_at)
        VALUES($1,$2,$3,'locationiq',$4,$5,$6,$7,'resolved',$8::jsonb,now()) ON CONFLICT(normalization_id,input_hash) DO UPDATE SET activated_at=now() RETURNING id`,
            [
              row.active_normalization_id,
              inputHash,
              queryNorm,
              LOCATION_GEOCODER_VERSION,
              lat,
              lng,
              coordinatePrecision ?? "point",
              JSON.stringify(metadata),
            ],
          )
        ).rows[0];
        // Every location this artifact knows (accepted and rejected), immutable per artifact.
        await writeRecordLocations(
          client,
          { research_poi_id: row.id, geocode_id: artifact.id, normalization_id: row.active_normalization_id },
          recordLocations({
            source: coordinateEvidence.source_coordinates
              ? { ...coordinateEvidence.source_coordinates, coordinate_source: row.coordinate_source }
              : null,
            inferred: coordinateEvidence.inferred_coordinates,
            basis: forwardBasis,
            fallbackFrom,
            rejected: rejected as never,
          }),
        );
        // Compare the original coordinates so a concurrent projection change cannot be overwritten.
        const activated = await client.query(
          `UPDATE research_pois SET lat=$11,lng=$12,coordinate_source=$13,coordinate_precision=$14,geocode_query_norm=$15,country_code=$2,city=$3,region=$4,address=$5,active_geocode_id=$6,
        attributes=(COALESCE(attributes,'{}'::jsonb)-'location_unresolved')||jsonb_build_object('location_enrichment',$7::jsonb),
        content_embedding=CASE WHEN city IS DISTINCT FROM $3 OR region IS DISTINCT FROM $4 OR country_code IS DISTINCT FROM $2 THEN NULL ELSE content_embedding END,
        active_embedding_id=CASE WHEN city IS DISTINCT FROM $3 OR region IS DISTINCT FROM $4 OR country_code IS DISTINCT FROM $2 THEN NULL ELSE active_embedding_id END
        WHERE id=$1 AND active_normalization_id=$8 AND lat IS NOT DISTINCT FROM $9::float8 AND lng IS NOT DISTINCT FROM $10::float8`,
          [
            row.id,
            resolved.fields.country_code,
            resolved.fields.city,
            resolved.fields.region,
            resolved.fields.address,
            artifact.id,
            JSON.stringify(metadata),
            row.active_normalization_id,
            row.lat,
            row.lng,
            lat,
            lng,
            coordinateSource,
            coordinatePrecision,
            forwardQueryNorm,
          ],
        );
        if (activated.rowCount !== 1)
          throw Object.assign(
            new Error("Location input changed during activation"),
            { code: "lineage_invalid" },
          );
        if (row.canonical_poi_id)
          await rebuildCanonicalPoi(client, row.canonical_poi_id, {
            noLlm: true,
          });
        return {
          value: undefined,
          output: {
            status: "succeeded",
            geocode_id: artifact.id,
            location_warnings: resolved.warnings,
            coordinate_kinds: Object.values(coordinateEvidence)
              .filter(Boolean)
              .map((p) => p!.kind),
            forward_lookup_state: metadata.forward.state,
          },
        };
      }),
    );
    stats.resolved++;
  }
  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  let stats: Awaited<ReturnType<typeof runGeocode>>;
  try {
    if (!opts.dryRun) await assertNoOutdatedSources(db, opts.source ?? null);
    useProviderQuotaLedger(db);
    stats = await runGeocode(db, opts);
  } finally {
    await db.end();
  }

  const mode = opts.dryRun ? " (dry-run)" : "";
  console.log(
    `Geocode${mode}${opts.source ? ` ${opts.source}` : ""}: selected=${stats.selected} ` +
      `cache_hits=${stats.cacheHits} known_misses=${stats.knownMisses} ` +
      `api_calls=${stats.apiCalls} resolved=${stats.resolved} unresolved=${stats.unresolved} ` +
      `no_query=${stats.noQuery}${
        stats.quota
          ? ` [LocationIQ daily quota reached — re-run after ${stats.quota.resets_at}]`
          : stats.budgetHit
            ? " [budget reached — re-run to continue]"
            : ""
      }`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((err) => {
    console.error("Geocode failed:", err);
    process.exit(1);
  });
