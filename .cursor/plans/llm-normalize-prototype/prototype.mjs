/**
 * Prototype: LLM-first normalization of messy research POI records.
 *
 * Feeds real records from docs/poi/ through DeepSeek-V4-Flash (DeepInfra) using a
 * candidate "normalize" prompt + JSON schema, and prints input vs output side by side.
 * Purpose: validate feasibility/quality before writing the implementation plan.
 *
 * Usage: node .cursor/plans/llm-normalize-prototype/prototype.mjs
 * Requires: DEEPINFRA_API_KEY in env. Read-only — touches no database tables.
 */
import fs from "node:fs";

const MODEL = process.env.LLM_MODEL || "deepseek-ai/DeepSeek-V4-Flash";
const BASE = "https://api.deepinfra.com/v1/openai";
const KEY = process.env.DEEPINFRA_API_KEY;
if (!KEY) throw new Error("DEEPINFRA_API_KEY not set");

// ── Sample records: real rows from the messiest sources ────────────────────
function load(file, n, unwrap, offset = 0) {
  let d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (unwrap) d = d[unwrap];
  return d.slice(offset, offset + n);
}

const samples = [
  // Reddit scrape: no dates, prose city, full country names, no source_record_id
  ...load("docs/poi/carnival/reddit_carnivals.json", 4).map((r) => ({ src: "reddit_carnivals", cat: "carnival", raw: r })),
  // Blog scrape: prose dates ("Through May 29, 2026"), non-carnival rows
  ...load("docs/poi/carnival/rick_steves_festivals.json", 4).map((r) => ({ src: "rick_steves", cat: "carnival", raw: r })),
  // Directory: edition years in names, "Trinidad"/"Florida" as country, inverted dates
  ...load("docs/poi/carnival/global_carnivalist.json", 5, null, 2).map((r) => ({ src: "global_carnivalist", cat: "carnival", raw: r })),
  // Directory: edition-year names, defunct festivals, listing url vs website
  ...load("docs/poi/music-festivals/directories/musicfestivalwizard_festivals.json", 3).map((r) => ({ src: "musicfestivalwizard", cat: "music_festival", raw: r })),
  // Directory: no dates, city-as-venue, cyrillic names, auto-generated descriptions
  ...load("docs/poi/music-festivals/directories/festivism_festivals.json", 3).map((r) => ({ src: "festivism", cat: "music_festival", raw: r })),
  // EDM directory: club nights mislabeled as festivals (is_festival flag)
  ...load("docs/poi/music-festivals/apis/edm_dance_directory.json", 3).map((r) => ({ src: "edm_dance_directory", cat: "music_festival", raw: r })),
];

// ── Candidate prompt (the thing being evaluated) ────────────────────────────
const SYSTEM = `You normalize raw scraped point-of-interest (POI) records for a world map of places and events.
You receive a JSON array of raw records. Each has "idx", "ingest_category" (the category the whole file is being imported as), and "raw" (verbatim scraped fields).

For each record, return one JSON object in an output array (same order, same "idx") with EXACTLY these fields:

- idx: integer, copied from input.
- is_poi: boolean. true only if this is a specific place or recurring/scheduled event that belongs on a map. false for: articles, category/index pages, regions or whole countries, organizations without a venue, tours spanning many cities, club nights or one-off parties at a bar/club, monuments described only as context, empty/placeholder rows.
- invalid_reason: string or null. Short machine-friendly reason when is_poi=false (e.g. "region_not_poi", "club_night", "tour_not_event", "empty_record", "article").
- kind: "place" | "event". Events are things with dates/editions (festivals, carnivals, fairs, parades); places are permanent.
- name: canonical display name. Strip edition years ("Trinidad Carnival 2026" -> "Trinidad Carnival"), trailing marketing text, and site boilerplate. Keep official native-language name; do not translate.
- name_alternates: array of other names found in the record (aliases, "also known as", translations). [] if none.
- edition_year: integer or null. Year stripped from the name or implied by the record's dates.
- venue: string or null. Specific venue/site name if present (never a city name repeated).
- address: string or null. Street address if present.
- city: string or null. The primary city/town. If the raw city field holds a region or multiple cities, pick the best-known primary city if the record clearly centers there, else null.
- region: string or null. State/province/region name.
- country_code: ISO 3166-1 alpha-2 code or null. Infer from any location text ("Trinidad" -> "TT", "Florida" -> "US", "Scotland" -> "GB", "Canary Islands" -> "ES").
- geocode_hint: string or null. Best single free-text location string for a geocoder, most-specific-first (e.g. "Frederiksted, St. Croix, US Virgin Islands"). null when coordinates present in raw.
- start_date / end_date: "YYYY-MM-DD" or null. Normalize any format (compact 20260820, prose "Nov 6, 2026", ISO timestamps). Fix obviously inverted ranges. For "Through <date>", set end_date only. Never invent dates not implied by the record.
- date_precision: "day" | "month" | "year" | null.
- recurrence: string or null. Short free text if the record indicates a recurring pattern ("annual, pre-Lent week", "every July").
- website: string or null. OFFICIAL site of the venue/event only. Directory/listing/aggregator/ticket/reddit URLs are NOT websites. Add https:// if scheme missing. null if none qualifies.
- description: string or null. 1-3 factual sentences describing the POI for a map user, drawn ONLY from record content. Remove scraper artifacts, marketing fluff, and auto-generated filler ("There is 1 recorded edition..."). null if nothing substantive.
- defunct: boolean. true if the record states the event no longer runs.
- confidence: number 0-1. Your overall confidence in this normalization.
- notes: string or null. Anything a human reviewer should know.

Rules:
- Use world knowledge to resolve locations to city/region/country_code, but NEVER invent venues, dates, websites, or descriptions not supported by the record.
- Output ONLY a JSON array, no markdown fences, no commentary.`;

async function run() {
  const input = samples.map((s, idx) => ({ idx, ingest_category: s.cat, raw: s.raw }));
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      max_tokens: 8000,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify(input) },
      ],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const ms = Date.now() - t0;
  const text = body.choices[0].message.content.trim().replace(/^```json?\n?|```$/g, "");
  const out = JSON.parse(text);

  const report = {
    model: MODEL,
    latency_ms: ms,
    usage: body.usage,
    batch_size: samples.length,
    results: samples.map((s, i) => ({
      source: s.src,
      input: s.raw,
      output: out.find((o) => o.idx === i) ?? null,
    })),
  };
  fs.writeFileSync(
    ".cursor/plans/llm-normalize-prototype/results.json",
    JSON.stringify(report, null, 2),
  );
  console.log(`ok: ${out.length}/${samples.length} records, ${ms}ms, tokens:`, body.usage);
  for (const r of report.results) {
    const o = r.output;
    console.log(
      `- [${r.source}] ${JSON.stringify(r.input.name ?? r.input.title ?? "?")} -> ` +
        (o
          ? `is_poi=${o.is_poi}${o.invalid_reason ? `(${o.invalid_reason})` : ""} name=${JSON.stringify(o.name)} loc=${o.city ?? "-"}/${o.region ?? "-"}/${o.country_code ?? "-"} dates=${o.start_date ?? "-"}..${o.end_date ?? "-"} site=${o.website ?? "-"} conf=${o.confidence}`
          : "MISSING"),
    );
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
