import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { countryNameToCode, str } from "./utils.js";
import { synthSourceRecordId } from "../hash.js";

interface GardenologyRow {
  state?: string;
  country?: string;
  name?: string;
  city?: string;
  gardenology_url?: string;
}

export const gardenologyExtractor: Extractor = {
  slug: "gardenology",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as GardenologyRow;
      const name = str(row.name);
      if (!name) continue;
      const city = str(row.city) ?? str(row.state) ?? "";

      yield {
        source_record_id: synthSourceRecordId("gardenology", name, city),
        name,
        source_url: str(row.gardenology_url),
        city: str(row.city),
        region: str(row.state),
        country_code: countryNameToCode(str(row.country)),
        raw_category: "botanical garden",
        attributes: {
          country_name: str(row.country),
        },
        raw: row,
      };
    }
  },
};
