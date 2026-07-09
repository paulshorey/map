/**
 * Throwaway POC (not part of the pipeline): test batched structured extraction with
 * DeepSeek-V4-Flash against real messy docs/poi records to inform the LLM normalization
 * plan (prompt shape, batch size, latency, output quality, token cost).
 *
 * Usage: pnpm --filter @lib/db-map tsx scripts/ingest/poc-llm-enrich.ts
 */
import { readFileSync } from "node:fs";
import { ingestConfig } from "./config.js";

interface RawSample {
  source: string;
  raw: Record<string, unknown>;
}

function loadSamples(): RawSample[] {
  const carnivalcities = JSON.parse(
    readFileSync(
      "/Users/pshorey/git/map/docs/poi/carnival/carnivalcities_events_html.json",
      "utf8",
    ),
  ) as Record<string, unknown>[];
  const reddit = JSON.parse(
    readFileSync("/Users/pshorey/git/map/docs/poi/carnival/reddit_carnivals.json", "utf8"),
  ) as Record<string, unknown>[];
  const globalCarnivalist = JSON.parse(
    readFileSync("/Users/pshorey/git/map/docs/poi/carnival/global_carnivalist.json", "utf8"),
  ) as Record<string, unknown>[];

  const samples: RawSample[] = [];
  for (const r of carnivalcities.slice(0, 6)) samples.push({ source: "carnivalcities", raw: r });
  for (const r of reddit.slice(0, 4)) samples.push({ source: "reddit", raw: r });
  for (const r of globalCarnivalist.slice(0, 4)) samples.push({ source: "global_carnivalist", raw: r });
  return samples;
}

const SYSTEM_PROMPT = `You are a data-normalization assistant for a points-of-interest map. You receive a
batch of raw scraped records about carnivals/festivals. For EACH record, extract a
structured JSON object using ONLY information explicitly present in that record's fields
(name/description/city/country/etc). Never invent or guess facts that are not stated.

Rules:
- "is_poi": false if the record describes a region, article, umbrella organization, or is
  otherwise not a single real-world event/place (e.g. "carnival season in general").
- "canonical_name": the event name with edition years and boilerplate stripped (e.g.
  "110 Above Festival 2026" -> "110 Above Festival"). Keep it in "canonical_name" only;
  do not remove the year from other fields.
- "edition_year": the year if the name/date implies one edition, else null.
- Extract "address", "phone", "email", "website" ONLY if literally present somewhere in the
  record (including inside garbled/concatenated description text). Do not fabricate.
  "website" must be the event/venue's OWN site, not a directory/listing URL.
- "city", "region", "country": split from any combined/free-text location field. Use
  standard English country names. If a field like "city" actually contains a region or a
  parenthetical list of towns, put the best single city in "city" and move the rest to
  "region" or leave null rather than guessing.
- "summary": a neutral, concise (<= 2 sentences) factual summary using only stated facts.
  Do not editorialize.
- "start_date"/"end_date": ISO YYYY-MM-DD only if a specific date is explicitly given.
  "date_precision": "day" | "month" | "year" | null.
- Fields you cannot determine MUST be null (or [] for array fields), never omitted, never
  guessed.

Reply with ONLY a JSON array, one object per input record IN THE SAME ORDER, shaped like:
{
  "source_record_id": string,
  "is_poi": boolean,
  "invalid_reason": string|null,
  "canonical_name": string|null,
  "edition_year": number|null,
  "alternate_names": string[],
  "venue": string|null,
  "address": string|null,
  "city": string|null,
  "region": string|null,
  "country": string|null,
  "phone": string|null,
  "email": string|null,
  "website": string|null,
  "organizer": string|null,
  "start_date": string|null,
  "end_date": string|null,
  "date_precision": string|null,
  "summary": string|null
}`;

async function callLlm(batch: RawSample[]): Promise<{ text: string; usage: unknown }> {
  const { model, baseUrl, apiKey } = ingestConfig.llm;
  const userPayload = batch.map((s, i) => ({
    source_record_id: s.raw.source_record_id ?? s.raw.id ?? s.raw.url ?? `sample_${i}`,
    ...s.raw,
  }));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 4000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(userPayload, null, 1) },
      ],
      thinking: { type: "disabled" },
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: unknown;
  };
  return { text: body.choices?.[0]?.message?.content ?? "", usage: body.usage };
}

async function main() {
  const samples = loadSamples();
  console.log(`Loaded ${samples.length} real messy samples across 3 sources.\n`);

  const t0 = Date.now();
  const { text, usage } = await callLlm(samples);
  const elapsedMs = Date.now() - t0;

  console.log(`--- Raw LLM response (${elapsedMs}ms) ---`);
  console.log(text);
  console.log(`\n--- Usage ---`);
  console.log(JSON.stringify(usage, null, 2));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("[");
    const end = text.lastIndexOf("]");
    parsed = JSON.parse(text.slice(start, end + 1));
  }
  const results = parsed as Record<string, unknown>[];

  console.log(`\n--- Parsed ${results.length} results (expected ${samples.length}) ---`);
  for (let i = 0; i < results.length; i++) {
    console.log(`\n[${i}] source=${samples[i]?.source}`);
    console.log(`  input.name: ${JSON.stringify(samples[i]?.raw.name ?? samples[i]?.raw.city)}`);
    console.log(`  output: ${JSON.stringify(results[i])}`);
  }
}

main().catch((err) => {
  console.error("POC failed:", err);
  process.exit(1);
});
