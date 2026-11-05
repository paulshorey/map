/** Shared location policy; the geocode stage owns optional coordinate enrichment. */
import { countryToCode } from "./normalize/country.js";
import { haversineMeters } from "./match/geo.js";
import { validPoint } from "../../lib/ingestion/location-points.js";
export const LOCATION_VERSION = "location-v8";
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
// Words that name the kind of place, not which one: "Biennale" alone identifies nothing.
const GENERIC_NAME_TOKENS = new Set(
  (
    "biennale biennial biennal bienal bienale biennalen triennale triennial trienal " +
    "quadriennale festival festivals fair art arts artes international internacional " +
    "contemporary contemporanea contemporain the and for of de la le les del della di du des " +
    "der und van een museum gallery galerie center centre park garden gardens online"
  ).split(" "),
);
const significantTokens = (value: string) =>
  foldTokens(value).filter(
    (t) => t.length >= 3 && !GENERIC_NAME_TOKENS.has(t.toLowerCase()),
  );

/** True when every distinctive word of the provider's place name appears in the listed name. */
export function providerNameAgrees(listedName: string, providerName: string) {
  const listed = new Set(significantTokens(listedName));
  const provider = significantTokens(providerName);
  return provider.length > 0 && provider.every((t) => listed.has(t));
}

/**
 * Why a forward result cannot stand for the listed text, or null when it can. A lookup of only
 * region/country text ("England", "East Africa", "USA / Mexico") locates at most a region: a
 * city, village, shop or restaurant it returns is a coincidence of names. A lookup by the POI's
 * name alone must return a place whose own name matches (not "Ray-Ban" for "RAY Fotografie").
 */
export function forwardImplausible(
  basis: string | null,
  listed: { city?: unknown; name?: unknown },
  hit: { precision: string; raw_response?: Record<string, unknown> | null },
): "locality_result_too_specific" | "name_result_mismatch" | null {
  if (
    basis === "locality" &&
    !localityValue(listed.city) &&
    hit.precision !== "region" &&
    hit.precision !== "country"
  )
    return "locality_result_too_specific";
  if (basis === "name" && hit.precision === "point") {
    const address = hit.raw_response?.address as Record<string, unknown> | undefined;
    const providerName = textValue(address?.name);
    const name = textValue(listed.name);
    if (!name || !providerName || !providerNameAgrees(name, providerName))
      return "name_result_mismatch";
  }
  return null;
}
/**
 * A lookup of only locality text locates at most that locality: a business it happens to
 * return ("Mosaicos Venecianos" for "Cuernavaca, Morelos") is labelled `city`, not `point`.
 */
export function capLocalityPrecision<
  T extends { precision: string; precision_evidence?: { value: string; derivation: string; warnings: string[] } },
>(basis: string | null, hit: T): T {
  if (basis !== "locality" || hit.precision !== "point") return hit;
  return {
    ...hit,
    precision: "city",
    ...(hit.precision_evidence
      ? {
          precision_evidence: {
            ...hit.precision_evidence,
            value: "city",
            derivation: "locality_query_cap",
            warnings: [...hit.precision_evidence.warnings, "locality_query_point_capped"],
          },
        }
      : {}),
  };
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
/**
 * A reverse lookup is only as specific as the point it was taken from. A country or
 * region centroid reverse-geocodes to whatever village lies under it, so fields finer
 * than the point's precision are dropped before they can fill listed locality.
 */
export function reverseForPrecision(
  reverse: ReverseLocation | null,
  precision: string | null | undefined,
): ReverseLocation | null {
  if (!reverse || !precision || precision === "point") return reverse;
  return {
    ...reverse,
    address: null,
    postcode: null,
    ...(precision === "region" || precision === "country" ? { city: null } : {}),
    ...(precision === "country" ? { region: null, region_code: null } : {}),
  };
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
