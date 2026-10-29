/** Shared location policy; the geocode stage owns optional coordinate enrichment. */
import { countryToCode } from "./normalize/country.js";
import { haversineMeters } from "./match/geo.js";
import { validPoint } from "../../lib/ingestion/location-points.js";
export const LOCATION_VERSION = "location-v3";
export const LOCATION_GEOCODER_VERSION = "locationiq-location-v4";
export const LOCATION_CACHE_VERSION = "location-v2";
export const LOCATION_QUERY_VERSION = "listed-location-v1";
export interface LocationFields {
  country_code: string | null;
  city: string | null;
  region: string | null;
  address: string | null;
}
export interface ReverseLocation extends LocationFields {
  region_code: string | null;
  postcode: string | null;
  distance_m: number;
  provider: string;
  attribution: string | null;
}
export const textValue = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

// Filler words that are never a place on their own. Quantifiers such as "Many" (a town in
// Louisiana) or "Multiple" count as filler only with a noun such as "venues".
const PLACEHOLDER_LOCALITY =
  /^((various|tba|tbc|tbd|n\/?a|unknown|online|virtual)( (venues?|locations?|cities|places|sites|spaces))?|(multiple|several|many) (venues?|locations?|cities|places|sites|spaces))$/i;
/** Directory filler such as "Various venues" is not a place and must never reach a geocoder. */
export const localityValue = (v: unknown): string | null => {
  const text = textValue(v);
  return text && !PLACEHOLDER_LOCALITY.test(text.replace(/[.\s]+$/, ""))
    ? text
    : null;
};

const foldTokens = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    // Any script's letters: 名古屋市 compares to 名古屋市, never silently to nothing.
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
const NAME_ABBREVIATIONS: Record<string, string> = {
  ST: "SAINT",
  STE: "SAINTE",
  MT: "MOUNT",
  FT: "FORT",
};
/** Whole folded name; "Kansas City" stays "KANSAS CITY" and never reduces to "KANSAS". */
const cityName = (value: string) =>
  foldTokens(value)
    .map((t) => NAME_ABBREVIATIONS[t] ?? t)
    .join(" ")
    .replace(/^(CITY|TOWN|VILLAGE|MUNICIPALITY|BOROUGH) OF /, "");
// City-level result fields only: a state, county or country never names the listed city.
const RESULT_CITY_KEYS = [
  "city",
  "town",
  "village",
  "hamlet",
  "municipality",
  "suburb",
  "city_district",
];

/** True when the result's city-level fields include the listed city's whole name (any script),
 * false when they name another place, null when nothing comparable exists. A listed qualifier
 * after a comma ("Washington, D.C.", "Portland, OR") is not part of the name. */
export function resultNamesListedCity(
  listedCity: unknown,
  // The display label is never compared: it also carries state and country names.
  hit: {
    city?: string | null;
    label?: string | null;
    raw_response?: Record<string, unknown>;
  },
): boolean | null {
  const listed = localityValue(listedCity);
  const wanted = listed ? cityName(listed.split(",")[0]!) : "";
  if (!/\p{L}/u.test(wanted)) return null;
  const address = (hit.raw_response?.address ?? {}) as Record<string, unknown>;
  const names = [hit.city, ...RESULT_CITY_KEYS.map((key) => address[key])]
    .map(textValue)
    .filter((p): p is string => !!p)
    .map(cityName)
    .filter((name) => /\p{L}/u.test(name));
  return names.length ? names.includes(wanted) : null;
}

/** Beyond this distance a result is not the listed city under another name. */
export const LOCALITY_CONFLICT_M = 50_000;

/** True when a venue/address lookup cannot be trusted to be in the listed city: its city-level
 * fields do not name the listed city (another script, such as Nagoya vs 名古屋市, is not a match), and it lies
 * more than LOCALITY_CONFLICT_M from an independent anchor (the source point or the listed city's
 * own lookup). Without an anchor, the caller verifies with a city-only lookup. Exonyms such as
 * Venice/Venezia pass through the distance gate. */
export function forwardLocalityConflict(
  listedCity: unknown,
  hit: {
    lat?: number;
    lng?: number;
    city?: string | null;
    region?: string | null;
    label?: string | null;
    raw_response?: Record<string, unknown>;
  },
  anchor?: { lat: number; lng: number } | null,
): boolean {
  const listed = localityValue(listedCity);
  // Only a record with no listed city skips verification; there is nothing to retry with.
  if (!listed || !/\p{L}/u.test(cityName(listed.split(",")[0]!))) return false;
  if (resultNamesListedCity(listed, hit) === true) return false;
  return !anchor || !validPoint(anchor) || !validPoint(hit)
    ? true
    : haversineMeters(anchor, hit) > LOCALITY_CONFLICT_M;
}
export function locationReadySql(alias = "rp"): string {
  return `(${alias}.attributes->'location_enrichment'->>'version'='${LOCATION_VERSION}'
    AND ${alias}.attributes->'location_enrichment'->>'normalization_id'=${alias}.active_normalization_id::text
    AND ${alias}.attributes->'location_enrichment'->'point'=jsonb_build_object('lat',${alias}.lat,'lng',${alias}.lng)
    AND ${alias}.attributes->'location_enrichment'->'forward'->>'query_version'='${LOCATION_QUERY_VERSION}'
    AND EXISTS(SELECT 1 FROM research_poi_geocodes lg WHERE lg.id=${alias}.active_geocode_id
      AND lg.normalization_id=${alias}.active_normalization_id AND lg.provider_version='${LOCATION_GEOCODER_VERSION}'
      AND lg.validation->'coordinate_evidence'=${alias}.attributes->'location_enrichment'->'coordinate_evidence'
      AND jsonb_typeof(lg.validation->'coordinate_evidence')='object'))`;
}
/** Never replace official text, and never apply a conflicting reverse address. */
export function resolveLocation(
  source: LocationFields,
  reverse: ReverseLocation | null,
) {
  const country = countryToCode(source.country_code) ?? null;
  const reverseCountry = countryToCode(reverse?.country_code) ?? null;
  const warnings: string[] = [];
  if (country && reverseCountry && country !== reverseCountry)
    warnings.push("coordinate_country_conflict");
  const fold = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toUpperCase();
  const region = textValue(source.region) ? fold(source.region!) : null;
  if (
    region &&
    reverse?.region &&
    region !== fold(reverse.region) &&
    region !== reverse.region_code?.toUpperCase() &&
    region !== reverse.region_code?.split("-").slice(1).join("-").toUpperCase()
  )
    warnings.push("coordinate_region_conflict");
  if (reverse && reverse.distance_m > 1000)
    warnings.push("reverse_result_too_distant");
  const usable = warnings.length === 0 ? reverse : null;
  const fields: LocationFields = {
    country_code: country ?? usable?.country_code ?? null,
    city: textValue(source.city) ?? usable?.city ?? null,
    region: textValue(source.region) ?? usable?.region ?? null,
    address: textValue(source.address) ?? usable?.address ?? null,
  };
  const provenance = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      value === null
        ? null
        : (
              key === "country_code"
                ? country
                : textValue(source[key as keyof LocationFields])
            )
          ? "source"
          : "reverse_geocode",
    ]),
  );
  return {
    fields,
    provenance,
    warnings,
    region_code: usable?.region_code ?? null,
    postcode: usable?.postcode ?? null,
  };
}
