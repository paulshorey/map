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

const PLACEHOLDER_LOCALITY =
  /^(various|multiple|several|many|tba|tbc|tbd|n\/?a|unknown|online|virtual)( (venues?|locations?|cities|places|sites|spaces))?$/i;
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
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
const GENERIC_CITY_TOKENS = new Set([
  "CITY",
  "THE",
  "NEW",
  "SAN",
  "SANTA",
  "SAINT",
  "DEL",
  "DES",
  "LOS",
  "LAS",
]);
const RESULT_LOCALITY_KEYS = [
  "city",
  "town",
  "village",
  "hamlet",
  "municipality",
  "suburb",
  "city_district",
  "county",
  "state_district",
  "state",
];

/** Beyond this distance a result is not the listed city under another name. */
export const LOCALITY_CONFLICT_M = 50_000;

/** True when a venue/address lookup landed in a Latin-script locality that never names the listed city
 * and lies more than LOCALITY_CONFLICT_M from an independent anchor (the source point) when one exists.
 * Non-Latin provider labels are not compared; the distance gate keeps exonyms such as
 * Venice/Venezia from counting as conflicts. */
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
  const city = localityValue(listedCity);
  const wanted = city
    ? foldTokens(city).filter(
        (t) => t.length >= 3 && !GENERIC_CITY_TOKENS.has(t) && /[A-Z]/.test(t),
      )
    : [];
  if (!wanted.length) return false;
  const address = (hit.raw_response?.address ?? {}) as Record<string, unknown>;
  const latin = (values: unknown[]) =>
    values
      .map(textValue)
      .filter((p): p is string => !!p)
      .map(foldTokens)
      .filter((tokens) => tokens.some((t) => /[A-Z]/.test(t)));
  // A label alone (no structured locality) cannot establish which city was found.
  const structured = latin([
    hit.city,
    hit.region,
    ...RESULT_LOCALITY_KEYS.map((key) => address[key]),
  ]);
  if (!structured.length) return false;
  const named = [...structured, ...latin([hit.label])].some((tokens) =>
    wanted.some((t) => tokens.includes(t)),
  );
  if (named) return false;
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
