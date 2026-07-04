import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { cleanName, countryNameToCode, str } from "./utils.js";
import { synthSourceRecordId } from "../hash.js";

interface WikipediaUsRow {
  state?: string;
  country?: string;
  name?: string;
  city?: string;
  wikipedia_url?: string;
  source_url?: string;
  founded?: string;
  area?: string;
  coordinates?: string;
}

export const wikipediaUsExtractor: Extractor = {
  slug: "wikipedia_us",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as WikipediaUsRow;
      const name = str(row.name);
      if (!name) continue;
      const city = str(row.city) ?? str(row.state) ?? "";

      yield {
        source_record_id: synthSourceRecordId("wikipedia_us", name, city),
        name: cleanName(name),
        source_url: str(row.wikipedia_url) ?? str(row.source_url),
        city: str(row.city),
        region: str(row.state),
        country_code: countryNameToCode(str(row.country)),
        raw_category: "botanical garden",
        attributes: {
          founded: str(row.founded),
          area: str(row.area),
          coordinates: str(row.coordinates),
          country_name: str(row.country),
        },
        raw: row,
      };
    }
  },
};
