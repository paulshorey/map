import { countryToCode } from "./normalize/country.js";
import { textValue } from "./location.js";
interface Row {
  id: string;
  source_slug: string;
  source_id: string;
  source_trust: number;
  lat: number | null;
  lng: number | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  address: string | null;
  attributes: Record<string, unknown> | null;
}
function method(row: Row, field: string): string {
  const loc = row.attributes?.location_enrichment as
    | { provenance?: Record<string, string> }
    | undefined;
  return loc?.provenance?.[field] ?? "source";
}
export function canonicalLocation<T extends Row>(
  rows: T[],
  coordinateRow: T | null,
) {
  const anchorCountry = countryToCode(coordinateRow?.country_code);
  // Administrative fields must come from this coordinate neighbourhood, never a distant member.
  const local = rows.filter(
    (r) =>
      coordinateRow &&
      r.lat !== null &&
      r.lng !== null &&
      coordinateRow.lat !== null &&
      coordinateRow.lng !== null &&
      Math.abs(r.lat - coordinateRow.lat) < 0.01 &&
      Math.abs(r.lng - coordinateRow.lng) < 0.01 &&
      (!anchorCountry ||
        !countryToCode(r.country_code) ||
        countryToCode(r.country_code) === anchorCountry),
  );
  const choose = (field: "country_code" | "city" | "region" | "address") => {
    const candidates = local
      .filter((r) =>
        field === "country_code"
          ? countryToCode(r.country_code)
          : textValue(r[field]),
      )
      .sort(
        (a, b) =>
          Number(method(a, field) === "reverse_geocode") -
            Number(method(b, field) === "reverse_geocode") ||
          b.source_trust - a.source_trust,
      );
    const row = candidates[0];
    return {
      value: row
        ? field === "country_code"
          ? (countryToCode(row[field]) ?? null)
          : textValue(row[field])
        : null,
      provenance: row
        ? {
            source: row.source_slug,
            source_id: row.source_id,
            research_id: row.id,
            derivation: method(row, field),
          }
        : null,
    };
  };
  return {
    country_code: choose("country_code"),
    city: choose("city"),
    region: choose("region"),
    address: choose("address"),
  };
}
