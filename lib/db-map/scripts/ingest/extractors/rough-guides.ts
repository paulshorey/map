import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { str } from "./utils.js";
import { synthSourceRecordId } from "../hash.js";

interface RoughGuidesRow {
  name?: string;
  city?: string;
  country?: string;
  dates?: string;
  description?: string;
  source_url?: string;
}

/**
 * Rough Guides "Europe's best alternative carnivals" article. Dates are prose
 * without a year ("February 11–13") → resolved by the normalize-stage LLM
 * fallback with structured year re-derivation.
 */
export const roughGuidesExtractor: Extractor = {
  slug: "rough_guides",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as RoughGuidesRow;
      const name = str(row.name);
      if (!name) continue;

      yield {
        source_record_id: synthSourceRecordId("rough_guides", name, str(row.city) ?? ""),
        name,
        description: str(row.description),
        source_url: str(row.source_url),
        city: str(row.city),
        raw_category: "carnival",
        attributes: {
          country_name: str(row.country),
          date_text: str(row.dates),
        },
        raw: row,
      };
    }
  },
};
