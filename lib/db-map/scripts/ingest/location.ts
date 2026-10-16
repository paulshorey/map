/** Shared location policy; the geocode stage owns optional coordinate enrichment. */
import { countryToCode } from "./normalize/country.js";
export const LOCATION_VERSION = "location-v1";
export const LOCATION_GEOCODER_VERSION = "locationiq-location-v2";
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
export function locationReadySql(alias = "rp"): string {
  return `(${alias}.attributes->'location_enrichment'->>'version'='${LOCATION_VERSION}'
    AND ${alias}.attributes->'location_enrichment'->>'normalization_id'=${alias}.active_normalization_id::text
    AND ${alias}.attributes->'location_enrichment'->'point'=jsonb_build_object('lat',${alias}.lat,'lng',${alias}.lng)
    AND EXISTS(SELECT 1 FROM research_poi_geocodes lg WHERE lg.id=${alias}.active_geocode_id
      AND lg.normalization_id=${alias}.active_normalization_id AND lg.provider_version='${LOCATION_GEOCODER_VERSION}'))`;
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
