/**
 * Generic extractor for files that follow the raw research capture spec
 * (docs/poi-research/capture-spec.md).
 *
 * Sources registered in sources.ts without a custom extractor fall back to this
 * one, so a new spec-conformant source needs only a metadata entry — no code.
 *
 * Field mapping is intentionally forgiving about common aliases (lat/latitude,
 * lng/lon/longitude, url/source_url, country/country_code) but does no other
 * normalization: cleanup belongs to ingest:normalize.
 */
import type { Extractor } from "../types.js";
import { streamRecords } from "../io.js";
import { str, num } from "./utils.js";

/** Fields mapped onto research_pois columns; everything else goes to attributes. */
const COLUMN_FIELDS = new Set([
  "source_record_id",
  "id",
  "name",
  "description",
  "website",
  "source_url",
  "url",
  "phone",
  "email",
  "address",
  "city",
  "region",
  "state",
  "state_region",
  "country",
  "country_code",
  "lat",
  "latitude",
  "lng",
  "lon",
  "longitude",
  "raw_category",
  "category",
  "raw",
]);

function attributeValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return value;
}

export const genericExtractor: Extractor = {
  slug: "generic",
  async *parse(file) {
    for await (const raw of streamRecords(file)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;

      const sourceUrl = str(r.source_url) ?? str(r.url);
      const id = str(r.source_record_id) ?? str(r.id) ?? sourceUrl;

      let countryCode = str(r.country_code);
      let countryName: string | undefined;
      const country = str(r.country);
      if (country) {
        if (!countryCode && /^[A-Za-z]{2}$/.test(country)) countryCode = country.toUpperCase();
        else countryName = country;
      }

      const attributes: Record<string, unknown> = {};
      if (countryName) attributes.country_name = countryName;
      for (const [key, value] of Object.entries(r)) {
        if (COLUMN_FIELDS.has(key)) continue;
        const v = attributeValue(value);
        if (v !== undefined) attributes[key] = v;
      }
      const nested = r.attributes;
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        delete attributes.attributes;
        for (const [key, value] of Object.entries(nested as Record<string, unknown>)) {
          const v = attributeValue(value);
          if (v !== undefined) attributes[key] = v;
        }
      }

      yield {
        source_record_id: id ?? "",
        name: str(r.name),
        description: str(r.description),
        website: str(r.website),
        source_url: sourceUrl,
        phone: str(r.phone),
        email: str(r.email),
        address: str(r.address),
        city: str(r.city),
        region: str(r.region) ?? str(r.state) ?? str(r.state_region),
        country_code: countryCode,
        lat: num(r.lat ?? r.latitude),
        lng: num(r.lng ?? r.lon ?? r.longitude),
        raw_category: str(r.raw_category) ?? str(r.category),
        attributes,
        raw: r,
      };
    }
  },
};
