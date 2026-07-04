import type { Extractor } from "../types.js";
import { streamCsv } from "../io.js";
import { str, num } from "./utils.js";

export const osmExtractor: Extractor = {
  slug: "osm",
  async *parse(file) {
    for await (const row of streamCsv(file)) {
      const osmId = str(row.osm_id);
      const osmType = str(row.osm_type) ?? "node";
      if (!osmId) continue;

      const gardenType = str(row.garden_type);
      const leisure = str(row.leisure);
      let rawCategory = "botanical garden";
      if (gardenType) rawCategory = `garden:type=${gardenType}`;
      else if (leisure) rawCategory = leisure;

      const wikidata = str(row.wikidata);
      const wikipedia = str(row.wikipedia);

      yield {
        source_record_id: `${osmType}/${osmId}`,
        name: str(row.name) ?? str(row.name_en),
        website: str(row.website),
        phone: str(row.phone),
        email: str(row.email),
        city: str(row.addr_city),
        region: str(row.addr_country),
        lat: num(row.lat),
        lng: num(row.lon),
        raw_category: rawCategory,
        attributes: {
          osm_id: osmId,
          osm_type: osmType,
          wikidata_id: wikidata?.startsWith("Q") ? wikidata : wikidata,
          wikipedia,
          opening_hours: str(row.opening_hours),
          operator: str(row.operator),
          fee: str(row.fee),
          access: str(row.access),
          description: str(row.description),
          addr_street: str(row.addr_street),
          addr_postcode: str(row.addr_postcode),
        },
        raw: row,
      };
    }
  },
};
