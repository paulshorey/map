import type { Extractor } from "../types.js";
import { streamJsonArray } from "../io.js";
import { str } from "./utils.js";

interface ArbnetRow {
  arbnet_id?: number;
  name?: string;
  slug?: string;
  url?: string;
  description?: string;
}

export const arbnetExtractor: Extractor = {
  slug: "arbnet",
  async *parse(file) {
    for await (const raw of streamJsonArray(file)) {
      const row = raw as ArbnetRow;
      const id = row.arbnet_id ?? row.slug;
      if (id === undefined || id === null) continue;

      yield {
        source_record_id: String(id),
        name: str(row.name),
        description: str(row.description),
        source_url: str(row.url),
        raw_category: "arboretum",
        attributes: {
          arbnet_id: row.arbnet_id,
          slug: str(row.slug),
        },
        raw: row,
      };
    }
  },
};
