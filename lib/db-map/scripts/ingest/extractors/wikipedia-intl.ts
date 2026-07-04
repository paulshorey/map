import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { cleanName, countryNameToCode, str } from "./utils.js";
import { synthSourceRecordId } from "../hash.js";

interface WikipediaIntlRow {
  country?: string;
  name?: string;
  city?: string;
  region?: string;
  notes?: string;
  founded?: string;
  area?: string;
  wikipedia_url?: string;
  source_url?: string;
}

export const wikipediaIntlExtractor: Extractor = {
  slug: "wikipedia_intl",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as WikipediaIntlRow;
      const name = str(row.name);
      if (!name) continue;
      const locality = str(row.city) ?? str(row.region) ?? str(row.country) ?? "";

      yield {
        source_record_id: synthSourceRecordId("wikipedia_intl", name, locality),
        name: cleanName(name),
        source_url: str(row.wikipedia_url) ?? str(row.source_url),
        city: str(row.city),
        region: str(row.region) ?? str(row.country),
        country_code: countryNameToCode(str(row.country)),
        raw_category: "botanical garden",
        attributes: {
          notes: str(row.notes),
          founded: str(row.founded),
          area: str(row.area),
          country_name: str(row.country),
        },
        raw: row,
      };
    }
  },
};
