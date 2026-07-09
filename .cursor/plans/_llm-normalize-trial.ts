/**
 * Ad-hoc LLM enrich trial against messy docs/poi samples.
 *
 * Not wired into package.json — used while designing/iterating the enrich prompt.
 *
 *   cd lib/db-map && node --import tsx ../../.cursor/plans/_llm-normalize-trial.ts
 *
 * Requires DEEPINFRA_API_KEY (and other ingest env) in the shell.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chat } from "../../lib/db-map/scripts/ingest/providers/deepinfra.js";

const SAMPLES =
  "/Users/pshorey/git/map/.cursor/plans/_llm-normalize-samples.json";
const OUT =
  "/Users/pshorey/git/map/.cursor/plans/_llm-normalize-trial-out.json";

const SYSTEM = `You normalize messy POI research records into clean structured JSON.
For each input record, return an object with:
- id: number — echo the input id
- is_poi: boolean — true only for a real place or recurring event people can visit
  (festival, carnival, campground, garden, venue). false for articles, blog posts,
  organizations, country pages, tour-route meta, club nights / one-off concerts,
  region-level overviews, Wikipedia meta pages.
- invalid_reason: string|null — snake_case when is_poi=false
- name: string|null — canonical display name WITHOUT edition years or "Nth edition"
- edition_year: number|null
- city: string|null
- region: string|null — state/province
- country_code: string|null — ISO-3166 alpha-2 only
- venue: string|null — venue/site name if distinct from city
- starts_at: string|null — YYYY-MM-DD when determinable
- ends_at: string|null
- date_precision: "day"|"month"|"year"|null
- website: string|null — official site only; never a directory listing URL
- source_url: string|null — listing/article URL
- description: string|null — plain text, no HTML, max ~400 chars
- confidence: number 0-1

Rules:
- Prefer evidence in the record; do not invent URLs or coordinates.
- If website looks like a directory/listing host, put it in source_url and set website null.
- For music/EDM rows with is_festival=false (or single-night club lineups), is_poi=false
  with invalid_reason=club_night unless clearly a multi-day festival.
- Reply with ONLY a JSON array matching input order. No markdown.`;

async function main() {
  const samples = JSON.parse(readFileSync(SAMPLES, "utf8")) as {
    source: string;
    raw: Record<string, unknown>;
  }[];

  const pick = (src: string) => samples.find((s) => s.source === src);
  const batch = [
    pick("global_carnivalist"),
    pick("festivalando"),
    pick("musicfestivalwizard"),
    pick("skiddle"),
    pick("unima"),
    pick("edm_false"),
    pick("edm_true"),
    pick("headout"),
  ]
    .filter(Boolean)
    .map((s, i) => ({
      id: i + 1,
      source: s!.source,
      ingest_category_hint:
        s!.source.startsWith("edm") ||
        s!.source === "musicfestivalwizard" ||
        s!.source === "skiddle" ||
        s!.source === "festivalando"
          ? "music_festival"
          : s!.source.includes("carnival") || s!.source === "global_carnivalist"
            ? "carnival"
            : "event",
      ...s!.raw,
    }));

  const t0 = Date.now();
  const out = await chat({
    system: SYSTEM,
    user: JSON.stringify({ records: batch }),
    maxTokens: 4000,
  });
  const elapsed = Date.now() - t0;

  let parsed: unknown;
  try {
    const trimmed = out.trim().replace(/^```json\s*|\s*```$/g, "");
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = { parse_error: true, raw: out };
  }

  const payload = { elapsed_ms: elapsed, input: batch, output: parsed };
  writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${OUT} (${elapsed}ms, ${batch.length} rows)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
