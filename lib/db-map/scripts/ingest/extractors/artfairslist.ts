import { streamRecords } from "../io.js";
import { synthSourceRecordId } from "../hash.js";
import type { Extractor, RawRecord } from "../types.js";
import { mapGenericRecord } from "./generic.js";
import { str } from "./utils.js";

function stableUrl(value: string | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/$/, "");
    return url.toString().replace(/\/$/, "");
  } catch { return value.trim(); }
}

/**
 * Art Fairs List repeats individual event listings with corrected names/addresses.
 * Keep each captured listing traceable with a stable source-local synthetic key;
 * matching/consolidation, rather than extraction, determines their canonical event.
 */
export const artFairsListExtractor: Extractor = {
  slug: "artfairslist",
  async *parse(file): AsyncIterable<RawRecord> {
    for await (const raw of streamRecords(file)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const input = raw as Record<string, unknown>;
      const mapped = mapGenericRecord(input, { sourceSlug: "artfairslist", editioned: true });
      if (!mapped) continue;
      const name = mapped.name ?? "";
      const date = str(input.start_date) ?? str(input.starts_at) ?? "";
      const address = mapped.address ?? "";
      const locality = [mapped.city, mapped.region, mapped.country_code, address].filter(Boolean).join("|");
      const official = stableUrl(str(input.website_url) ?? mapped.website);
      yield {
        ...mapped,
        source_record_id: synthSourceRecordId("artfairslist", `${official}|${name}`, locality, date),
        source_record_id_kind: "synthetic",
        identity_inputs: { name, locality, edition: date || null },
      };
    }
  },
};
