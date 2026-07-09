# Plan: LLM-Driven Research Normalization

> Supersedes Workstream D ("LLM Triage in Normalize") in
> `.cursor/plans/poi-ingestion-unfinished-work.md`. That workstream scoped the LLM to
> bounded triage (validity, name edition-stripping, locality splitting). This plan is
> broader: a single, cheap, cached, aggressively-used LLM pass that turns messy
> `research_pois` rows into much more complete, structured records — before the existing
> deterministic normalize/geocode/match/merge pipeline (unchanged in shape) does its job.
>
> Grounded in: a full read of `lib/db-map/scripts/ingest/**`, `docs/poi-ingestion.md`,
> `docs/poi-research/capture-spec.md`, the live database (`ingest:report`), and a working
> prototype (`lib/db-map/scripts/ingest/poc-llm-enrich.ts`) run twice against real rows from
> `docs/poi/carnival/`. Evidence and numbers below are from that run, not estimates.

---

## 1. Problem

`research_pois` rows from real scraped sources are far messier than the two structured
garden sources (`bgci`, `wikidata`, `osm`) the pipeline was mostly proven against. Examples
pulled directly from `docs/poi/carnival/`:

- `carnivalcities_events_html.json` — `description` is scraper-mangled HTML text with the
  address, phone, and website concatenated with no spaces:
  `"Associazione Carneval de CastelnovoVia Milano 537014 Castelnuovo del Garda (VR)ItaliaTel: +39 349 7433259Web:http://www.carnevaldecastelnovo.it"`.
  None of `address`, `phone`, or `website` are populated as fields — `official_website` is
  present but empty, so this record would ship with zero contact fields even though all
  three are sitting in the text.
- `reddit_carnivals.json` — no coordinates at all; `city` is often a composite region
  description (`"North Brabant region (Eindhoven/Lampegat, Den Bosch/Oeteldonk)"`), and two
  of ten sampled rows describe a *regional tradition*, not a single place/event
  (`"Carnaval / Vasteloavend (North Brabant)"`, `"Kölner Karneval (Cologne Carnival)"`) —
  these should never become map POIs but nothing currently flags them.
- `global_carnivalist.json` — `also_known_as` holds sentence fragments
  (`"better known as Sugar Mas"`) instead of a clean alternate name; `country` holds
  non-ISO, non-standard values (`"St.Kitts"`, `"St.Croix"` — the latter isn't a country at
  all, it's part of the U.S. Virgin Islands).
- Across `docs/poi/music-festivals/directories/`, names embed edition years/ordinals
  (`"110 Above Festival 2026"`, `"Strolls to the Mirror in Martigues, 19th edition"`) that
  make `name_normalized` differ year to year, which weakens the matcher's ability to
  collapse editions into one canonical with multiple `canonical_poi_occurrences`.

Today's `ingest:normalize` (`lib/db-map/scripts/ingest/normalize.ts`) is almost entirely
deterministic. The only LLM use anywhere in ingestion is: prose event-date parsing
(`normalize/dates.ts`), match adjudication for gray-zone pairs, and canonical description
fusion when sources disagree (`match/llm.ts`, `merge.ts`). Nothing extracts structured
fields from unstructured text, fixes malformed locality/country values, flags non-POI rows
by content (only one hardcoded bare-QID-name rule exists today), or cleans display names.
The result: `canonical_pois` built from these sources will be sparse (missing address/
phone/website that's actually available in the text) and will under-collapse recurring
events.

This directly affects two already-known pain points in
`poi-ingestion-unfinished-work.md`: locality-based match scoring (`match/score.ts`
`localityScore`, exact `sameText` comparison) is weakened by messy city/region text, and the
festival "city-precision publish policy" problem (Workstream E) exists partly *because*
venue/address text that would geocode to point precision is sitting unused in description
blobs instead of reaching the geocoder query.

## 2. What was validated (not just designed)

`lib/db-map/scripts/ingest/poc-llm-enrich.ts` sends 14 real records (6 from
`carnivalcities_events_html.json`, 4 from `reddit_carnivals.json`, 4 from
`global_carnivalist.json`) to the model already configured in
`scripts/ingest/config.ts` (`deepseek-ai/DeepSeek-V4-Flash` via DeepInfra,
`scripts/ingest/providers/deepinfra.ts`), in one batched call, asking for a structured JSON
array. Full transcript in terminal history; representative results:

- Correctly pulled `address: "Via Milano 537014 Castelnuovo del Garda (VR) Italia"`,
  `phone: "+39 349 7433259"`, and `website: "http://www.carnevaldecastelnovo.it"` out of the
  garbled Castelnuovo description — all three previously unpopulated fields, all correct.
- Correctly set `is_poi: false` with a reason for both regional-tradition rows
  ("North Brabant", "Cologne Carnival"), and left every other field appropriately null
  rather than guessing.
- Correctly cleaned `also_known_as` fragments into a proper `alternate_names: ["Sugar Mas"]`
  / `["Mas Dominik"]`, and stripped edition years into `canonical_name` +
  `edition_year: 2026`.
- Was inconsistent on country resolution across the two runs (`"St. Kitts"` vs left as-is;
  `"Trinidad"` → `"Trinidad and Tobago"` on one run, `"Trinidad"` on the other). This is
  expected and is exactly why §8 routes LLM-produced country/city text back through the
  **existing deterministic normalizers** (`normalize/country.ts` `countryToCode`) instead of
  trusting it as a final value — the model's job is turning unstructured text into
  structured-but-still-raw fields, not being the source of truth for controlled vocabularies.

**Cost** (from the API's own `usage.estimated_cost`): $0.00092–$0.00100 for the batch of 14,
i.e. **~$0.00007/record**. Ungated, across every JSON record currently sitting in
`docs/poi/{carnival,art-fairs,art-parades,music-festivals}` (counted directly, see §13:
~133,575 records), that is **under $10 total**. Cost is not a design constraint here —
correctness and throughput are.

**Latency**: both runs (with and without `thinking: "disabled"` — DeepInfra's hosted
preview endpoint did not measurably honor that flag) took ~160–190s for one call covering
14 records, i.e. ~12–13s/record serialized. This *is* a real constraint and drives the
concurrency design in §10 — cost is a non-issue, wall-clock throughput is the thing to
engineer for.

## 3. Design Overview

Add one new pipeline stage, **`ingest:enrich`**, that runs between `extract` and
`normalize`:

```
extract → enrich (NEW, LLM) → normalize (existing, deterministic) → geocode → embed → match
```

`enrich` reads raw-ish `research_pois` rows, and for rows that look like they need it
(§7), sends a batch to the LLM and writes results back into **the same columns
`normalize`/`geocode`/`merge` already read** (`address`, `city`, `region`, `country_code`,
`phone`, `email`, `website`, `is_poi`) plus a documented `attributes` sub-schema (§6) for
fields with no existing column (`clean_name`, `edition_year`, `alternate_names`, `venue`,
`organizer`, `summary`). It **only fills gaps**; it never overwrites a field that already
has a usable verbatim value from the source. This means:

- `normalize.ts` needs no structural changes — it already treats populated `city`/`region`/
  `country_code` as authoritative and only falls back to centroid/reverse-geocoding when
  empty (`normalize/centroids.ts` lines 155–170). Once `enrich` has filled those fields,
  `normalize` simply has less work to do and better inputs.
- `geocode.ts`'s query builder (`buildQuery`, lines 104–133) already reads
  `attributes->>'venue'` as the first component of the geocode query string. An
  LLM-extracted venue name flows into a *better geocode query* with **zero changes to
  `geocode.ts`** — likely turning many currently `city`/`region`-precision festival rows
  into `point`-precision ones, which directly un-hides canonicals under the existing
  `rebuildCanonicalPoi` publish rule (`merge.ts` line 532). This reduces (does not
  eliminate) the urgency of the Workstream E "city-precision publish policy" decision.
- `merge.ts` already reads `row.website`, `row.phone`, `row.address` straight from
  `research_pois` columns when building canonicals — filling those columns at `enrich` time
  means richer canonicals with **zero changes to `merge.ts`**, except the one deliberate
  change in §9 (prefer `attributes.llm.clean_name` for the canonical display name).

Everything is deterministic-first, LLM-for-gaps-only, matching the existing house style
(`docs/poi-ingestion.md` "Operating Principles": *"Prefer deterministic signals first... Use
the LLM only for bounded ambiguous decisions"*) — this plan just draws the boundary much
wider than the old Workstream D triage, because the model is cheap enough to be generous
with, while safety comes from routing its output back through existing deterministic
normalizers rather than trusting it directly.

## 4. Schema change (one migration)

```sql
ALTER TABLE research_pois ADD COLUMN enriched_at timestamptz;
CREATE INDEX research_pois_todo_enrich ON research_pois (id) WHERE enriched_at IS NULL AND is_poi;
```

That's it — no new tables. Reasoning:

- **No cache table needed.** `research_pois.content_hash` already exists and already drives
  reprocessing (`extract.ts` `UPDATE_CHANGED_SQL` resets derived columns, including
  `attributes`, whenever content changes; unchanged re-imports only bump `last_seen_at` and
  leave `attributes` untouched). Storing the enrichment result under `attributes.llm` gets
  content-hash-keyed caching for free — it survives idempotent re-imports and is wiped
  automatically when source content actually changes.
- **No new "pending" flag logic needed beyond one column.** `enriched_at` follows the exact
  convention already used for `name_normalized`, `content_embedding`, etc.: null means
  pending, set means done, and `ingest:reflow` resets it to force reprocessing after a
  prompt/schema change (see §10) — the same mechanism already documented for normalize/
  embed/match changes in `docs/poi-ingestion.md` "Reflow and Backfills".
- Extract's changed-row branch (`extract.ts` `UPDATE_CHANGED_SQL`, lines 133–144) must add
  `enriched_at = NULL` to its reset list, alongside the existing `name_normalized = NULL`
  etc. `reflow.ts`'s reset list (lines 55–68) must add the same.

No columns are added for `clean_name`/`edition_year`/`alternate_names`/`venue`/`organizer`/
`summary` — they live in `attributes` (jsonb, already indexed loosely via existing usage,
no new index needed since nothing filters on them directly).

## 5. Enrichment contract

One LLM call per batch, strict JSON array output, `temperature: 0`, one object per input
record in the same order (the current match/date LLM calls already follow this
parse-defensively pattern — reuse `match/llm.ts`'s `parseJsonObject` bracket-scan fallback,
generalized to arrays).

```ts
interface EnrichmentResult {
  source_record_id: string; // echoed back for join safety, not trusted for ordering
  is_poi: boolean;          // may only downgrade true->false, never upgrade
  invalid_reason: string | null;
  clean_name: string | null;      // edition/boilerplate stripped; null if no change needed
  edition_year: number | null;
  alternate_names: string[];
  venue: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;         // free text; routed through countryToCode(), not trusted directly
  phone: string | null;
  email: string | null;
  website: string | null;         // must be the place/event's own site, not a directory URL
  organizer: string | null;
  start_date: string | null;      // ISO YYYY-MM-DD, only if explicit in source text
  end_date: string | null;
  date_precision: "day" | "month" | "year" | null;
  summary: string | null;         // <=2 sentences, facts already present in the record only
}
```

Input to the model per record: the full captured row as seen by later stages — `name`,
`description`, `website`, `source_url`, `phone`, `email`, `address`, `city`, `region`,
`country_code`, `raw_category`, and the full `attributes` blob (everything the extractor
couldn't map to a column). Giving it everything captured, not a curated subset, is
deliberate — `docs/poi-research/capture-spec.md` guarantees unknown source fields survive
into `attributes`, so the model sees exactly what a human researcher would.

System prompt rules (validated in the POC, keep these near-verbatim):

1. Never invent or guess a fact not explicitly present in the record's own fields.
2. `is_poi: false` for regions, articles, umbrella organizations, or "general tradition"
   descriptions rather than one concrete place/event.
3. `clean_name` strips edition years/ordinals/boilerplate; the edition-bearing form is never
   discarded (it stays in the original `name` column — verbatim capture is preserved
   forever in `raw` and untouched in `name`; `enrich` never writes `name`).
4. Extract `address`/`phone`/`email`/`website` only if literally present, including inside
   garbled/concatenated text; `website` must be the subject's own site, not the scraper's
   listing/directory domain.
5. Split combined/free-text locality into `city`/`region`/`country`; when uncertain, prefer
   leaving a field null over guessing which part is the city vs the region.
6. `summary`: neutral, concise, no editorializing, no facts beyond what's stated.
7. Every field must be present and null/[] when unknown — never omit a key (keeps downstream
   parsing simple and batch-shape-checkable).

## 6. Guardrails (this is the part that makes "aggressive LLM use" safe)

- **Never overwrite a populated field.** `enrich` only writes to `city`/`region`/
  `country_code`/`phone`/`email`/`website`/`address` when the existing value is null or
  empty — matching the "LLM output never overwrites captured source fields" rule already
  established for `date_source: "llm"` in `normalize/dates.ts`.
- **Country/city text is not trusted directly.** `EnrichmentResult.country` is passed
  through the existing `countryToCode()` (`normalize/country.ts`) exactly like any other
  source-provided country string — this is what the pipeline already does for
  `attributes.country_name`, so `enrich` just gives it a better-quality input, using the
  same code path (extend `COUNTRY_NAME_TO_CODE`/`SUBNATIONAL_TO_CODE` with the couple of
  gaps the POC surfaced: Saint Kitts and Nevis, Trinidad and Tobago, U.S. Virgin Islands).
  `city`/`region` still flow through `applyCentroidRules` exactly as today.
- **`website` is denylist-checked** with the existing `isDeniedDomain()`
  (`match/denylist.ts`) before being written, and rejected if its domain equals the row's
  own `source_url` domain (the most likely LLM mistake mode: promoting the listing page).
- **`is_poi` can only move true→false, never false→true.** An extractor-level `isPoi()`
  exclusion (e.g. `edm_dance_directory`'s `is_festival` flag) is final; `enrich` is an
  additional, stricter filter layered on top, not a way to resurrect excluded rows.
- **Coordinates are never LLM-sourced.** `enrich` does not touch `lat`/`lng`; it can only
  improve the geocoder's *input* (`venue`, `address`, cleaner `city`/`region`), never the
  coordinates themselves. This preserves the existing trust model where coordinates come
  only from `source`, `url`, or `geocode` (`coordinate_source` check constraint).
- **Schema validation with bounded retry.** Parse defensively (bracket-scan fallback like
  `match/llm.ts`); if the array length doesn't match the batch or any object fails the
  shape check, retry the whole batch once with a sharper reminder; on second failure, fall
  back to per-row singleton calls for just the still-failing rows; if a single row still
  fails, mark `enriched_at = now()` with `attributes.llm_error` set so the pipeline moves on
  and never retries a poison row forever (mirrors the existing `LlmError` non-fatal pattern
  in `normalize/dates.ts`'s `proseDatesViaLlm`).
- **Field-level provenance.** Every field `enrich` fills gets recorded in
  `attributes.field_source[field] = "llm"` (vs `"source"` implicitly for everything already
  populated at extract time). This is purely observational today, but makes it possible
  later to weight LLM-filled locality fields slightly lower in `match/score.ts`'s
  `localityScore` if that ever proves necessary — not proposed as a change now, just kept
  cheap to add later because the provenance already exists.

## 7. Heuristic gate — be generous, not exhaustive

Given the cost math in §2, the gate exists to bound **latency**, not spend. Send a row to
the LLM if it `is_poi` and has *any* of:

- `description` present and non-empty (this is where garbled contact info hides), OR
- Any of `address`/`phone`/`email`/`website`/`city`/`region` is null while `description` or
  any `attributes` value is non-empty (there's text to mine), OR
- `city` or `region` contains a comma, parenthesis, or slash (composite/free-text signal:
  `"North Brabant region (Eindhoven/Lampegat, Den Bosch/Oeteldonk)"`), OR
- `name` matches an edition-year/ordinal pattern (`/\b(19|20)\d{2}\b/`, `/\d+(st|nd|rd|th)\s+edition/i`)
  not already resolved by the cheap deterministic stripper (see §9), OR
- The row is from a category known to be directory/prose-scraped (`carnival`, `art_fair`,
  `art_parade`, and the `music_festival` "directories" subset) — an allowlist by source
  slug is simplest to start, refined once real data is seen.

Skip rows that already look clean: structured API sources with coordinates, a plausible
`city`, and no free-text signal (e.g. most of `musicbrainz`/`ticketmaster`/`viberate`,
already-clean `bgci`/`wikidata`/`osm` garden rows). This keeps the gate itself cheap
(computed in SQL/JS over already-fetched rows, no LLM call spent deciding whether to spend
an LLM call).

## 8. Consolidating existing ad hoc LLM date parsing

`normalize/dates.ts`'s `proseDatesViaLlm` (lines 173–197) already does a single-purpose LLM
call for prose dates, memoized only in an in-process `Map` (lost every run — a real
inefficiency). Once `enrich` runs first and produces `start_date`/`end_date`/
`date_precision` as part of the same batched call, `parseEventDates` should:

1. Try the existing deterministic parse first (unchanged — `parseOneDate`, ISO/compact/
   month-name forms).
2. If that fails, use `enrich`'s persisted result (`attributes.llm.start_date` etc.) instead
   of making a fresh, unmemoized LLM call.
3. Remove `proseDatesViaLlm` and its in-memory memo once (2) is wired up — this is a net
   simplification, not just an addition, and gets *persistent* (survives process restarts)
   caching for free where today's date LLM cache does not.

## 9. Name/edition handling — deterministic first, LLM for the rest

Add a small, cheap, always-on regex stripper in `normalize/text.ts` (no LLM) that handles
the common cases directly: trailing 4-digit years (`/\s+(19|20)\d{2}$/`) and
`", Nth edition"` suffixes. This alone likely resolves most of
`musicfestivalwizard_festivals.json`'s "110 Above Festival 2026" pattern for free.

`enrich`'s `clean_name`/`edition_year`/`alternate_names` are the fallback for what regex
can't confidently handle (embedded years mid-string, prose-derived aliases like
`"better known as Sugar Mas"`). Whichever produced a clean name (regex or LLM,
regex-first-wins) must feed **`name_normalized` computation in `normalize.ts`**, not just
sit in `attributes` for display — this is the wiring that actually helps the matcher
collapse editions into one canonical with multiple `canonical_poi_occurrences`, since
`match/score.ts`'s `nameSimilarity` and the matcher generally operate on `name_normalized`.
Concretely: `normalize.ts` line 143's
`row.name ? normalizeName(row.name) : null` becomes
`normalizeName(attrs.llm?.clean_name ?? stripEdition(row.name) ?? row.name)`.

`merge.ts`'s `chooseText` for the canonical `name` field (line 446) should prefer
`attrs.llm?.clean_name` per candidate row over raw `row.name` when present, so
"110 Above Festival 2026" displays as "110 Above Festival" on the map, not just matches
correctly under the hood. `organizer`/`alternate_names`/`edition_year` merge into
`canonical_pois.attributes` the same way `contained_features` already does (no new
canonical columns needed for v1; `email` likewise stays in `attributes` rather than adding a
canonical column, since `contracts/map-app.ts`'s `PoiDetailRecord` has no email field today —
flagged as an open decision in §14 if the product wants it surfaced).

## 10. Execution model

New script `lib/db-map/scripts/ingest/enrich.ts`, package script `ingest:enrich`:

```bash
pnpm --filter @lib/db-map ingest:enrich [--source <slug>] [--limit N] [--dry-run] [--concurrency N] [--batch-size N]
```

- Selects rows via `research_pois_todo_enrich` (`enriched_at IS NULL AND is_poi`), applies
  the §7 heuristic in-process; rows that don't need enrichment are stamped
  `enriched_at = now()` immediately with zero LLM cost (so they never get rechecked) —
  same "cheap skip, mark done" pattern as the bare-QID skip in `normalize.ts`.
- Rows that do need it are grouped into batches of ~20–30 (large enough to amortize the
  fixed system-prompt token cost, small enough to keep a single failed batch's retry cost
  low) and dispatched with bounded concurrency (`--concurrency`, default ~12–16 to start,
  well under DeepInfra's documented 2500-request Flash concurrency ceiling; tune up if no
  429s are observed via the existing `LlmError` 429 handling in `providers/deepinfra.ts`).
- Each row is committed independently once its batch's result is parsed (same "commit as
  you go, resumable" model as `ingest:match`) — a killed/Ctrl-C'd run leaves completed rows
  stamped and resumes cleanly.
- `--no-llm` is not offered as a separate flag here since the *whole stage* is LLM; omitting
  `ingest:enrich` from a run (or running the rest of the pipeline without it) is the
  equivalent — rows simply keep `enriched_at IS NULL` forever and downstream stages behave
  exactly as they do today (this is why the stage is additive/optional-by-omission, safe to
  land incrementally).
- `ingest:reflow` gains `enriched_at = NULL` in its reset list (and should clear
  `attributes.llm*` / `attributes.field_source` keys) so a prompt/schema change can force
  full re-enrichment the same way changing match/normalize logic does today.

## 11. Observability

Extend `ingest:report` (`report.ts`) with one more section, following its existing style:

```
## LLM enrichment
source            total    enriched   needed_llm  llm_filled_addr  llm_filled_city  flagged_invalid
```

Plus print running cost/row-count/elapsed at the end of `ingest:enrich` itself, same shape
as `ingest:geocode`'s summary line (`api_calls`, `resolved`, `unresolved`, budget-hit note).

## 12. Rollout order

1. Migration (§4) + `enrich.ts` (§10) + country-alias gaps (§6) — land behind the fact that
   omitting the stage is a no-op for existing sources (safe to merge early).
2. Pilot on the 25 already-extracted-but-not-normalized `global_carnivalist` rows (see
   `ingest:report` output below — this source is sitting at `normalized=0` right now,
   making it a clean, real, zero-risk first target). Compare canonical output with and
   without `enrich` in the chain.
3. Wire `normalize.ts` (§9 name/date changes), `merge.ts` (§9 clean-name preference), verify
   `geocode.ts` benefits from `attributes.venue` with no code change (§3).
4. Extend `ingest:report` (§11).
5. Run ahead of the bulk campground/festival/carnival/art-fair imports already planned in
   `poi-campgrounds-festivals-import.md` — enrichment should run as step 2 in that runbook's
   per-source sequence (right after `ingest:extract`, before `ingest:normalize`).
6. Revisit the Workstream E city-precision publish policy decision only after measuring how
   many festival rows reach `point` precision purely from LLM-extracted venue text — the
   policy question may shrink substantially.

Current live baseline for comparison (`pnpm --filter @lib/db-map ingest:report`, captured
during this planning session): 9,731 linked research rows, all from clean garden sources
(`bgci`/`wikidata`/`osm`); `global_carnivalist` (25 rows) is the only messy-source data
currently in the database, extracted but not yet normalized — an ideal, low-risk pilot
target with zero blast radius on existing published canonicals.

## 13. Cost & throughput estimate

Raw record counts, counted directly from `docs/poi/` JSON files (this session):

| Folder | Files | Records (rough, top-level arrays) |
| --- | --- | --- |
| `docs/poi/carnival/` | 46 | ~2,084 |
| `docs/poi/art-fairs/` | 52 | ~27,303 |
| `docs/poi/art-parades/` | 73 | ~8,705 |
| `docs/poi/music-festivals/` | 52 | ~95,482 |
| **Total** | 223 | **~133,575** |

(Campground sources are mostly CSV with clean columns and coordinates — comparatively low
enrichment need, not counted here; music-festivals' total is inflated by several already
well-structured API dumps — musicbrainz, ticketmaster, viberate — that the §7 gate should
mostly skip.)

- **Cost, fully ungated, every record**: 133,575 × ~$0.00007/record ≈ **$9–10 total**. Even
  10x this estimate is noise against any real project budget.
- **Throughput**: observed ~12–13s/record serialized. At `--concurrency 16`,
  ~16 × (30 records/batch) / (~350s per 30-record batch, linear extrapolation from the
  14-record measurement) ≈ **~1.4 rows/sec ≈ 5,000 rows/hour**. The full ungated corpus
  would take ~27 hours serialized-per-worker-equivalent; realistically, with the §7 gate
  skipping already-clean API-sourced rows, the LLM-bound subset is a fraction of 133,575 —
  plan for a **single overnight run** per major category, resumable via `enriched_at` if
  interrupted.
- Cost and throughput should both be re-measured with real production concurrency once
  `enrich.ts` exists — the POC only proves per-call cost/quality, not the concurrent
  aggregate (DeepInfra rate limits under real parallel load are unverified).

## 14. Acceptance criteria

- A directory-scraped carnival/festival source (e.g. re-running `global_carnivalist`, or a
  newly extracted messy source) normalizes with address/phone/website populated for records
  where that data is present in unstructured text, verified by spot-checking
  `ingest:normalize --report-coverage --source <slug>` before/after.
- Rows describing regions/organizations/general traditions (not one place/event) are flagged
  `is_poi = false` with a reason and never reach `canonical_pois`.
- Edition-year name variants of the same festival collapse into one canonical with multiple
  `canonical_poi_occurrences` (verify against `musicfestivalwizard_festivals.json`'s
  "110 Above Festival" 2026/2027-style entries once that source is ingested).
- Re-running `ingest:enrich` on already-enriched, unchanged rows makes zero LLM calls
  (`enriched_at IS NOT NULL` short-circuits selection) and `ingest:reflow` correctly forces
  re-enrichment.
- No canonical field is ever traceable to an invented fact — every LLM-filled field's
  provenance (`attributes.field_source`) points back to something present in `raw`.
- `ingest:report` shows the new LLM enrichment section with plausible counts after a pilot
  run.

## 15. Open decisions for the user

1. **`email` as a first-class canonical field?** Currently proposed to stay in
   `attributes` only, since `contracts/map-app.ts`'s `PoiDetailRecord` has no email field
   and the app doesn't render one. Adding a real column + contract field is a small,
   separate follow-up if the product wants it surfaced (would need `db:sync` per
   `AGENTS.md`).
2. **Source-slug allowlist vs. universal gate for §7?** Starting with an allowlist
   (carnival/art_fair/art_parade + festival "directories") is simplest and matches where
   the messiness actually lives today; a fully content-based gate (no source allowlist) is
   more general but harder to validate up front. Recommend starting with the allowlist and
   widening once the pilot's precision/recall on "needs enrichment" is visually spot-checked.
3. **Concurrency ceiling for `--concurrency`.** DeepInfra's documented Flash concurrency
   limit is 2500 requests, far above anything proposed here, but real sustained throughput
   under parallel load is unverified — the plan recommends starting conservative (12–16) and
   tuning up from observed 429 rates rather than guessing higher up front.

## 16. Relationship to other plans

- **Supersedes** Workstream D in `poi-ingestion-unfinished-work.md` — that section should be
  trimmed to a pointer to this file (done in this session).
- **Complements** Workstream E's city-precision publish-policy decision (§3, §12.6) —
  recommend deferring that decision until after a pilot run measures how much LLM-extracted
  venue text moves festivals to point precision.
- **Feeds** Workstream F (end-to-end validation) — the validation doc should include a
  before/after enrichment comparison for at least one messy source.
- Runs as step 2 (right after `ingest:extract`) in each per-source sequence in
  `poi-campgrounds-festivals-import.md` once implemented.

## 17. Supporting artifact

`lib/db-map/scripts/ingest/poc-llm-enrich.ts` — throwaway but runnable POC used to validate
this plan. Not wired into the package.json scripts or the production pipeline; kept as
evidence and a starting point for `enrich.ts`. Safe to delete once `enrich.ts` supersedes it,
or keep as a fixture for prompt-iteration experiments.
