import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { str, num } from "./utils.js";

interface WikidataRow {
  wikidata_id?: string;
  name?: string;
  country?: string;
  latitude?: string;
  longitude?: string;
  website?: string;
  founded?: string;
  area_ha?: string;
  wikidata_url?: string;
}

export const wikidataExtractor: Extractor = {
  slug: "wikidata",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as WikidataRow;
      const qid = str(row.wikidata_id);
      if (!qid) continue;

      yield {
        source_record_id: qid,
        name: str(row.name),
        website: str(row.website),
        source_url: str(row.wikidata_url),
        region: str(row.country),
        lat: num(row.latitude),
        lng: num(row.longitude),
        raw_category: "botanical garden",
        attributes: {
          wikidata_id: qid,
          founded: str(row.founded),
          area_ha: num(row.area_ha),
          country_name: str(row.country),
        },
        raw: row,
      };
    }
  },
};
