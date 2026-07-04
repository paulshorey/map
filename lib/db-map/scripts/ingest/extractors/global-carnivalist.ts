import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { str } from "./utils.js";
import { synthSourceRecordId } from "../hash.js";

interface GlobalCarnivalistRow {
  name?: string;
  also_known_as?: string;
  city?: string;
  country?: string;
  location_raw?: string;
  start_date?: string;
  end_date?: string;
  date_raw?: string;
  description?: string;
  official_website?: string;
  url?: string;
}

/**
 * globalcarnivalist.com upcoming-carnivals scrape. Known hazards (survey):
 * swapped start/end dates (St. Maarten), territories in the country field,
 * street addresses in the city field. Dates go to attributes for the
 * normalize-stage parser (swap repair happens there).
 */
export const globalCarnivalistExtractor: Extractor = {
  slug: "global_carnivalist",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as GlobalCarnivalistRow;
      const name = str(row.name);
      if (!name) continue;

      yield {
        source_record_id: synthSourceRecordId("global_carnivalist", name, str(row.city) ?? ""),
        name,
        description: str(row.description),
        website: str(row.official_website),
        source_url: str(row.url),
        city: str(row.city),
        raw_category: "carnival",
        attributes: {
          also_known_as: str(row.also_known_as),
          country_name: str(row.country),
          location_raw: str(row.location_raw),
          start_date: str(row.start_date),
          end_date: str(row.end_date),
          date_text: str(row.date_raw),
        },
        raw: row,
      };
    }
  },
};
