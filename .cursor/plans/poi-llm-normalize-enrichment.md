# Plan: LLM Research Enrichment in Normalize

> Status: ready to implement. Spun out of Workstream D in
> `.cursor/plans/poi-ingestion-unfinished-work.md`. Broader than the original
> "triage" sketch: use DeepSeek-V4-Flash to turn messy captured rows into
> high-quality `research_pois` before geocode / embed / match.
>
> Companion samples used while drafting:
> `.cursor/plans/_llm-normalize-samples.json` (27 messy records from carnival,
> festival, and art-parade scrapes).

---

## 1. Problem

Capture is intentionally verbatim (`docs/poi-research/capture-spec.md`). That is
correct for mining, but today's `ingest:normalize` barely interprets the mess:

| What normalize does today | What survives into match / rebuild |
| --- | --- |
| `normalizeName` for matching | Display `name` still has edition years |
| Wikidata QID → `is_poi=false` (only when `name_normalized IS NULL`) | 333 bare `Q…` names still `is_poi=true` in prod (normalized before the gate) |
| Deterministic + prose-date LLM | Dates only; no persistent cache |
| Centroid reverse-fill for city | OSM/Wikidata still ~38% city / 62% country overall |
| Phone / website domain / coord fixes | HTML descriptions (`<p>…`) published as-is |
| Category = `--category` | Articles, orgs, club nights, region overviews never rejected |

Live DB (gardens only, ~9.9k rows): 0 non-POI flags, 320 HTML descriptions, 333
QID names still matchable, 962 hidden canonicals. Festival/carnival/campground
sources in `docs/poi/` are far messier and mostly not ingested yet — directory
scrapes, blog posts, edition-year names, free-text `location`, listing URLs in
`website`, tour stops, country pages.

`rebuildCanonicalPoi` can only elect among what research rows contain. Messy
`research_pois` → weak canonicals, bad geocode queries, weak name blocks, and
hidden city-precision festivals.

DeepSeek-V4-Flash on DeepInfra is already wired (`LLM_MODEL` default) at
**$0.09 / $0.18 per 1M tokens** (~$3 for 100k rows at batch size 25). Cost is not
the constraint — coverage and caching are.

---

## 2. Goal

Make `research_pois` the **cleaned working copy** of each source record, so
geocode / embed / match / `rebuildCanonicalPoi` operate on complete, consistent
fields. Keep `raw` jsonb as verbatim provenance. Keep match/consolidate as the
aggregation layer — do not ask the LLM to invent canonicals.

**Success looks like:**

1. Directory-scraped festival/carnival sources normalize to ≥95% usable
   `city` + `country_code` among `is_poi` rows.
2. Edition-year names collapse to one base name; year lands in
   `attributes.edition_year` / occurrence dates — match merges editions.
3. Non-POIs (articles, orgs, regions, club nights, tour meta) get
   `is_poi=false` + `attributes.invalid_reason` and never geocode/match.
4. Descriptions are plain text (HTML stripped, truncated sensibly).
5. `website` is official-only; listing URLs stay in `source_url`.
6. Rerunning normalize on unchanged rows makes **zero** LLM calls
   (persistent cache keyed by `content_hash` + prompt version).
7. `--no-llm` preserves today's deterministic behavior.

Non-goals: human review queue, per-source cleanup scripts, changing match
scoring, PostGIS/pgvector, scraping new data.

---

## 3. Evidence from a live trial

Batched 8 messy records through DeepSeek-V4-Flash with a draft enrich schema
(~57s wall, one call). Results:

| Input | Model output | Verdict |
| --- | --- | --- |
| `Trinidad`/`St. Kitts Carnival` scrapes | Base name, `Basseterre`/`KN`, dates, official site | Good |
| Festivalando blog title | `is_poi=false`, `blog_post` | Good |
| `10000 Lakes Festival 2009` | name → `10000 Lakes Festival`, `edition_year=2009`, dates | Good |
| Skiddle `location: "…Sheffield…"` | city=`Sheffield`, `GB`, parsed Aug 2026 dates | Good |
| Headout listicle | `is_poi=false`, `blog_post` | Good |
| EDM `is_festival:false` club night | Incorrectly kept `is_poi=true` | **Prompt must take category + source flags** |
| UNIMA event page | Kept as POI; website=listing | Needs stricter website vs source_url rules |

Conclusion: one structured enrich call can replace a pile of brittle parsers, but
the prompt must be category-aware and schema-validated. Club-night / one-off
concert rejection needs explicit rules for temporal categories.

---

## 4. Design

### 4.1 Keep one stage, two phases

Stay on `ingest:normalize` (operators already know it; geocode must see enriched
locality). Internally:

```
extract (verbatim → research_pois.raw + columns)
    ↓
normalize phase A — deterministic (existing rules, no LLM)
    ↓
normalize phase B — LLM enrich (batched, cached)   ← NEW
    ↓
geocode → embed → match → consolidate
```

Do **not** add a separate `ingest:enrich` command unless phase B grows large
enough to want independent resume UX. Resume signal stays
`name_normalized IS NULL` for phase A; phase B uses
`attributes.normalize.prompt_version IS DISTINCT FROM $current` (or missing
cache hit) so prompt upgrades can re-enrich without full reflow.

CLI:

```bash
pnpm --filter @lib/db-map ingest:normalize [--source <slug>] [--limit N] \
  [--no-llm] [--llm auto|always|never] [--dry-run] [--batch-size 25]
```

- `--no-llm` / `--llm never` — phase A only (today's behavior + any new
  deterministic rules).
- `--llm auto` (default) — LLM when `needsEnrich(row)` is true.
- `--llm always` — LLM every POI row (use for first festival/carnival imports).

### 4.2 What the LLM returns (strict JSON)

One object per input row, same order. Reject the whole batch on schema mismatch
and retry once; on second failure, fall back to phase-A-only for those rows and
log.

```jsonc
{
  "id": "research_pois.id",          // echo for alignment
  "is_poi": true,
  "invalid_reason": null,            // snake_case when is_poi=false
  "name": "Base Display Name",       // no edition year / "Nth edition"
  "edition_year": 2026,              // null if none
  "city": "Long Beach",
  "region": "CA",                    // state/province; null if unknown
  "country_code": "US",              // ISO-3166 alpha-2 only
  "venue": "Shoreline Waterfront",   // distinct from city when known
  "address": null,
  "starts_at": "2026-08-20",         // YYYY-MM-DD or null
  "ends_at": "2026-08-22",
  "date_precision": "day",           // day|month|year|null
  "website": "https://official.example",  // official only
  "source_url": "https://directory.example/listing",
  "description": "Plain-text summary…",   // no HTML; ≤600 chars
  "aliases": ["AKA …"],
  "confidence": 0.9
}
```

`invalid_reason` vocabulary (extend as needed):

`blog_post`, `article`, `organization`, `tourist_board`, `country_page`,
`region_overview`, `tour_stop`, `club_night`, `concert_one_off`,
`wikipedia_meta`, `not_a_place`, `insufficient_evidence`, `wikidata_qid_name`.

### 4.3 Apply rules (never lose provenance)

| Field | Write policy |
| --- | --- |
| `raw` | Untouched (verbatim capture) |
| `name` | Replace with LLM `name` when `is_poi` and confidence ≥ 0.6; original preserved in `raw` and `attributes.normalize.name_raw` |
| `name_normalized` | Recompute from cleaned `name` via existing `normalizeName()` |
| `city` / `region` / `country_code` | Fill when empty **or** when LLM confidence ≥ 0.8 and current value looks wrong (e.g. country=`Florida`, city=`Nationwide`, city=`unknown`) |
| `address` | Fill when empty |
| `website` / `source_url` | Swap/correct when LLM identifies listing URL in `website`; never invent URLs not present in input |
| `description` | Replace when HTML detected or empty and LLM returns text; strip tags deterministically first, LLM only if still messy/empty |
| `starts_at` / `ends_at` / `date_precision` | Prefer deterministic parse; LLM fills gaps; trust explicit years in source text (fix today's `rederiveYears` blind overwrite for enrich path) |
| `is_poi` | Set false + `invalid_reason` when model says so (or deterministic gates) |
| `attributes` | Merge `normalize` block (below), `edition_year`, `venue`, `aliases`; never delete source-specific keys |

`attributes.normalize` block (audit + resume):

```jsonc
{
  "normalize": {
    "prompt_version": "enrich-v1",
    "model": "deepseek-ai/DeepSeek-V4-Flash",
    "cached": false,
    "confidence": 0.9,
    "name_raw": "Trinidad Carnival 2026",
    "fields_set": ["name", "city", "country_code", "starts_at", "edition_year"],
    "at": "2026-07-09T…"
  },
  "edition_year": 2026,
  "venue": "…"
}
```

### 4.4 Deterministic gates first (`needsEnrich`)

Always run phase A. Call LLM in `auto` mode when any of:

1. `is_poi` still true and name matches `/^q\d+$/i` (also handle in phase A alone).
2. Name contains a 4-digit year or `/\b\d{1,2}(st|nd|rd|th)\s+edition\b/i`.
3. `city` empty/unknown/`nationwide`/multi-city free text, or `country_code` null.
4. `country`/`region` fields look like US states or territories in the wrong column
   (reuse/extend `countryToCode` miss patterns).
5. Description contains HTML tags or length > 1200.
6. `website` host equals a known directory host, or equals `source_url` host for
   directory sources.
7. Temporal category (`music_festival`, carnival, art-fair, …) and dates still null
   after deterministic parse.
8. Source metadata flag `enrich: "always"` in `sources.ts`.

Skip LLM when phase A already produced a complete, clean row (typical for
coordinate-rich Dyrt/RIDB/OSM campgrounds with plain names).

### 4.5 Batching, validation, provider

- Batch **25** rows default (CLI `--batch-size`, clamp 10–50).
- Temperature 0; `max_tokens` ~4000 for batch of 25.
- Prefer DeepInfra JSON mode / `response_format: { type: "json_object" }` if
  stable; otherwise fence-strip + `JSON.parse`.
- Validate with a Zod (or hand-rolled) schema: required keys, ISO dates,
  `country_code` length 2, URL host allowlist check (output URL must appear in
  input URLs or be null).
- Align by echoed `id`; if count mismatch, reject batch.
- Throttle lightly (existing DeepInfra client); on 429 backoff and retry.
- Extend `providers/deepinfra.ts` with `chatJson<T>()` helper used by enrich,
  match adjudication, and (later) date parsing.

### 4.6 Persistent cache

New table (migration + `db:sync`):

```sql
CREATE TABLE research_normalize_cache (
  content_hash   text NOT NULL,
  prompt_version text NOT NULL,
  model          text NOT NULL,
  result         jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, prompt_version)
);
```

Lookup before every LLM batch member. On hit, apply cached `result` with
`attributes.normalize.cached = true`. Bump `prompt_version` (`enrich-v1` →
`enrich-v2`) when the schema/prompt changes — old cache rows remain for audit
but are not used.

This mirrors `research_consolidation_decisions` and is why reruns are free.

Also fold today's in-memory prose-date memo into this cache (or a sibling key
`prompt_version = 'dates-v1'`) so `--reflow` does not re-pay for dates.

### 4.7 Category-aware system prompt

One system prompt with a short **category addendum** injected from
`ingest_category`:

- `music_festival` / carnival / art-fair: reject club nights, one-off concerts,
  blog posts, nationwide overviews; strip edition years; venue ≠ city.
- `campground` / `rv` / `tent`: reject highway waypoints / "overview" rows;
  keep amenity attributes untouched; HTML→text descriptions.
- `gardens`: reject bare QIDs; clean HTML; do not invent coordinates.
- Default: place-or-recurring-event only.

Pass into the user payload: `ingest_category`, source slug, trust, and the raw
fields (name, location fields, dates, urls, description truncated to ~800 chars,
selected attributes). Do **not** send full `raw` blobs.

### 4.8 Downstream consumers

Small follow-ups so enrichment actually reaches the map:

1. **`rebuildCanonicalPoi` / `merge.ts`** — prefer research `name` as cleaned
   (already does); prefer non-HTML descriptions; if multiple names differ only by
   edition year, treat as same after strip (match already has date/edition logic —
   verify base-name equality benefits).
2. **`buildEmbedText`** — uses `name_normalized` + city + region; automatically
   improves when those are enriched (re-embed after reflow).
3. **`geocode.buildQuery`** — events already locality-only; better city/country
   raises hit rate. Optionally append `attributes.venue` for temporal categories.
4. **`ingest:report`** — add lines: non-POI count by reason, enrich cache hit
   rate, % rows with `attributes.normalize`, city/country coverage among `is_poi`.
5. **QID cleanup one-shot** — SQL or tiny script: mark existing
   `name ~ '^Q[0-9]+$'` as `is_poi=false` (they never re-enter normalize while
   `name_normalized` is set).

### 4.9 Source metadata hook

In `sources.ts`, optional:

```ts
enrich: "auto" | "always" | "never"  // default auto
```

Set `always` for: `musicfestivalwizard`, `global_carnivalist`, `festivalando`,
`edm_dance_directory`, `skiddle`, rough-guides-style scrapes, UNIMA, headout.
Set `never` only if a source is proven clean end-to-end (rare).

---

## 5. Implementation plan

### Step 0 — Fix latent QID leak (half day)

```sql
UPDATE research_pois
SET is_poi = false,
    attributes = attributes || '{"invalid_reason":"wikidata_qid_name"}'::jsonb
WHERE name ~ '^Q[0-9]+$' AND is_poi;
```

Confirm with `ingest:report`. Prevents 333 junk gardens from staying matchable
while the larger enrich work lands.

### Step 1 — Cache migration + JSON helper

- Migration `research_normalize_cache`.
- `pnpm db:sync`; commit schema/generated.
- `chatJson()` in `providers/deepinfra.ts`.
- Constant `NORMALIZE_PROMPT_VERSION = "enrich-v1"`.

### Step 2 — Deterministic upgrades in phase A

Cheap wins before any LLM:

- HTML strip utility for descriptions (`stripHtml` keep text/links).
- Edition-year strip regex for names → `attributes.edition_year` when unambiguous
  (`/^(.*?)[\s,:-]+(19|20)\d{2}$/`).
- Expand `countryToCode` / wrong-column heuristics (`Florida`→US+region, etc.).
- Treat `city` in `{unknown, nationwide, n/a, …}` as empty.
- Website-vs-source_url host check against a small directory-host list.

These alone improve gardens HTML and some carnival geo without tokens.

### Step 3 — Enrich module

New files under `scripts/ingest/normalize/`:

| File | Role |
| --- | --- |
| `enrich.ts` | `needsEnrich`, batching, cache lookup/store, apply |
| `enrich-schema.ts` | Zod/JSON schema + parse/validate |
| `enrich-prompt.ts` | system prompt + category addenda |
| `html.ts` | deterministic HTML→text |

Wire into `normalize.ts` after the existing per-row phase A loop: collect rows
that need enrich, batch, apply, update stats (`enriched`, `cacheHits`,
`invalidated`, `llmCalls`).

### Step 4 — Golden fixtures + eval script

- `scripts/ingest/normalize/enrich.golden.json` — 20–30 hand-checked cases from
  `_llm-normalize-samples.json` (festivalando reject, MFW edition strip, Skiddle
  locality, EDM club night reject, FECC org reject, RIDB HTML clean, QID reject).
- `pnpm --filter @lib/db-map ingest:normalize:eval` — runs golden set against
  the live model (or cached fixtures in CI with `--no-llm` schema-only checks).
- Acceptance gate: ≥90% exact on `is_poi` + `invalid_reason` class; ≥85% on
  `country_code` / base `name` when `is_poi`.

### Step 5 — Pilot imports

1. Extract + normalize `--llm always --limit 100` on
   `musicfestivalwizard` and `global_carnivalist`.
2. `ingest:report --source …` — city/country coverage, non-POI reasons, cache.
3. Geocode → embed → match `--limit 100` → spot-check canonical names/dates.
4. Full source runs once golden looks good.
5. Reflow gardens (`ingest:reflow --category gardens` then normalize) to clean
   HTML descriptions and backfill missing cities where centroids failed.

### Step 6 — Docs

Update:

- `docs/poi-ingestion.md` — normalize stage description, cache, flags.
- `lib/db-map/README.md` — CLI flags.
- `docs/poi-research/capture-spec.md` — point at enrich (still: capture verbatim).
- Slim Workstream D in unfinished-work plan to a pointer here.

---

## 6. Cost & performance sketch

| Volume | Batches (25) | Est. tokens | Est. $ (Flash) |
| --- | --- | --- | --- |
| 1k messy festival rows | 40 | ~0.2M in + 0.15M out | **~$0.05** |
| 10k MFW | 400 | ~2M + 1.5M | **~$0.45** |
| 100k mixed | 4k | ~20M + 15M | **~$3–4** |
| Rerun unchanged | 0 LLM | cache hits | **$0** |

Wall clock dominated by API latency (~1–2 s/batch if parallelized carefully;
start serial, add concurrency 2–4 with 429 backoff). Not on the match critical
path for gardens already linked.

---

## 7. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| LLM invents URLs / coords / facts | URL must appear in input; never write lat/lng from LLM; confidence threshold |
| Over-rejection of real POIs | Golden set; `confidence` + log; `--llm auto` skips clean rows |
| Under-rejection of club nights | Category addendum + `is_festival` / duration heuristics in `needsEnrich` |
| Overwriting good source names | Keep `name_raw` in attributes; only replace when edition/boilerplate detected or confidence high |
| Prompt drift breaks cache | Versioned `prompt_version`; bump intentionally |
| Batch schema failures | Reject + retry once; per-row fallback to phase A |
| Reflow storms | Cache makes re-enrich cheap; don't null `content_hash` |
| Hidden festivals (city precision) | Separate Workstream E publish-policy decision — enrich improves locality but does not invent venue coords |

---

## 8. Acceptance checklist

- [ ] `research_normalize_cache` migrated; types generated; committed.
- [ ] Existing QID-named rows are `is_poi=false`.
- [ ] `ingest:normalize --no-llm` matches prior deterministic behavior (+ Step 2 rules).
- [ ] `ingest:normalize --llm always --source musicfestivalwizard --limit 100` yields
      ≥95% city+country among remaining `is_poi` rows; edition years stripped;
      blog/non-POI rate sane on a mixed source (festivalando dry extract).
- [ ] Second identical normalize run: `llmCalls=0`, `cacheHits=100`.
- [ ] Golden eval ≥90% on validity class.
- [ ] Spot-checked canonicals show clean names, plain descriptions, correct
      official websites.
- [ ] Docs updated; unfinished-work Workstream D points here.

---

## 9. Suggested build order

1. Step 0 QID cleanup (immediate, unblocks garden quality).
2. Steps 1–3 core enrich path with cache.
3. Step 4 golden eval; tighten prompt on EDM/club-night failures.
4. Step 5 pilots (MFW + global_carnivalist), then gardens reflow.
5. Step 6 docs + mark Workstream D done in unfinished-work plan.

After this lands, campground/festival runbook imports
(`.cursor/plans/poi-campgrounds-festivals-import.md`) should run with
`--llm always` on scraped directories and `--llm auto` on coordinate-rich
sources (Dyrt, RIDB, OSM).
