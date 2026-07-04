import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { str, countryNameToCode } from "./utils.js";
import { synthSourceRecordId } from "../hash.js";

interface IabgRow {
  region?: string;
  country?: string;
  name?: string;
  alt_name?: string;
}

export const iabgExtractor: Extractor = {
  slug: "iabg",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as IabgRow;
      const name = str(row.name);
      if (!name) continue;
      const country = str(row.country);

      yield {
        source_record_id: synthSourceRecordId("iabg", name, country ?? ""),
        name,
        region: str(row.region),
        country_code: countryNameToCode(country) ?? undefined,
        raw_category: "botanical garden",
        attributes: {
          alt_name: str(row.alt_name),
          country_name: country,
          iabg_region: str(row.region),
        },
        raw: row,
      };
    }
  },
};
