import { readFile } from "node:fs/promises";
import type { Extractor, RawRecord } from "../types.js";
import { mapGenericRecord } from "./generic.js";
import { str } from "./utils.js";

/** Listing location components mix cities, regions and countries; keep them as hints.
 * The captured venue point anchors administrative enrichment, not those split labels.
 */
export function mapFestivalLocation(raw: unknown): RawRecord | null {
  const record = mapGenericRecord(raw, { sourceSlug: "thatfestivalsite" });
  if (!record) return null;
  const value = raw as Record<string, unknown>;
  const attributes = { ...record.attributes };
  delete attributes.country_name;
  attributes.source_location_hints = {
    city: record.city ?? null,
    region: record.region ?? null,
    country: str(value.country) ?? record.country_code ?? null,
    location: str(value.location) ?? null,
    venue: str(value.venue_full) ?? str(value.venue) ?? null,
  };
  attributes.location_admin_policy = "coordinate_lookup";
  return {
    ...record,
    city: undefined,
    region: undefined,
    country_code: undefined,
    attributes,
  };
}

export const thatFestivalSiteExtractor: Extractor = {
  slug: "thatfestivalsite",
  async *parse(file) {
    const document = JSON.parse(await readFile(file, "utf8"));
    if (!Array.isArray(document?.festivals))
      throw new Error("That Festival Site capture requires a festivals array");
    for (const raw of document.festivals) {
      const record = mapFestivalLocation(raw);
      if (record) yield record;
    }
  },
};
