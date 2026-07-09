# Plan: LLM-First Normalization of Research POIs

> Status: proposed, awaiting review. Supersedes "Workstream D — LLM Triage in Normalize"
> in `.cursor/plans/poi-ingestion-unfinished-work.md`.
>
> Prototype validated 2026-07-09 against real messy records — see
> `.cursor/plans/llm-normalize-prototype/` (script + `results.json`) and §3 below.

---

## 1. Problem

`ingest:normalize` today is a deterministic pass (name lowering, coordinate fixes,
phone/country cleanup, date parsing) with the LLM used only as a prose-date fallback.
That works for structured sources (BGCI, Wikidata, OSM — the 9.8k garden rows currently
in the database), but the next wave of sources in `docs/poi/` is scraped blogs, Reddit
threads, and directory listings. For those, deterministic code cannot:

- Tell a real POI from an article, a region, a club night, or a tour leg
  (`is_poi` is effectively always true — no extractor implements `isPoi`).
- Strip edition years ("Trinidad Carnival 2026") so editions block/merge into one
  canonical with occurrences.
- Resolve free-text locality ("Tampa Bay, Florida" with `country: "Florida"`;
  "Canary Islands"; "North Brabant region (Eindhoven/…)") into city/region/ISO country.
- Demote listing/aggregator URLs wrongly captured as `website`
  (ra.co, reddit.com, globalcarnivalist.com, festival directories).
- Repair inverted or prose date ranges ("Through May 29, 2026", "April 30 & May 1"
  captured as `end_date` before `start_date`).
- Clean scraper-artifact descriptions ("There is 1 recorded edition, spanning from
  2016 to 2016.") into something worth electing at the canonical layer.

The result today: messy `research_pois` rows flow into matching and election, and
`canonical_pois` quality is capped by them. Downstream stats confirm the gap — of 6,352
published canonicals only 1,839 have descriptions, and locality-dependent stages
(geocode, locality match signals) start from whatever the scrape happened to contain.

DeepSeek-V4-Flash is cheap enough to run over **every messy row** (measured:
~$0.000056/record → ~$5.60 per 100k records). This plan makes an LLM normalization pass
the primary path in `ingest:normalize`, with deterministic code re-scoped to
preparation, validation, and guardrails.

## 2. Design Overview

Keep the pipeline shape and CLI contract. `ingest:normalize` stays one command in the
same position (extract → **normalize** → geocode → embed → match), but internally
becomes three phases:

```
Phase A  Deterministic prep      (always)   coord fix/swap, URL coords, phone, domain,
                                            category slugs — today's cheap transforms
Phase B  LLM normalization       (policy)   batched DeepSeek call per 25 rows,
                                            cached by content_hash + prompt_version
Phase C  Validate + apply        (always)   strict schema check, guardrails, write columns;
                                            per-row fallback to deterministic-only output
```

Principles carried over from Workstream D, still binding:

- **LLM never overwrites captured source data.** `raw`, `name`, `description`,
  `website`, `source_url` columns stay verbatim; LLM output lands in separate
  normalized columns (§4) — same pattern as `date_source: "llm"`.
- **Reproducible and resumable.** Temperature 0, versioned prompt, DB cache keyed by
  `content_hash`; reruns and `--reflow` on unchanged rows make **zero** LLM calls.
- **`--no-llm` degrades to today's behavior** (deterministic-only, Phase A + C).
- **LLM proposes, code disposes.** Every LLM field passes a deterministic validator
  before it is written (§6).

### What the LLM produces per row

One JSON object per input row (see prototype prompt in
`.cursor/plans/llm-normalize-prototype/prototype.mjs`, to be extracted as
`normalize/llm-prompt.ts` with a `PROMPT_VERSION`):

| Field | Purpose downstream |
| --- | --- |
| `is_poi` + `invalid_reason` | Validity gate: rejects articles, regions, club nights, tours, empty rows |
| `kind` (`place`/`event`) | Cross-check against category `is_temporal`; mismatch → flag |
| `name` (canonical, edition year stripped) | Canonical display name; basis of `name_normalized` → editions block together |
| `name_alternates` | Extra match signal; stored in attributes |
| `edition_year` | Occurrence bookkeeping for events |
| `venue` | Geocode query + display |
| `address`, `city`, `region`, `country_code` (ISO-2) | Locality fill from prose; match signals; geocode |
| `geocode_hint` | Single best free-text geocoder query, most-specific-first |
| `start_date`, `end_date`, `date_precision` | Replaces the prose-date LLM fallback; repairs inversions |
| `recurrence` | Attributes; future occurrence inference |
| `website` (official only, or null) | Demotes listing URLs; validated in Phase C |
| `description` (1–3 factual sentences) | Clean per-row description → far better canonical description election |
| `defunct` | Publish policy for dead events |
| `confidence`, `notes` | Apply policy (§6) and operator review |

## 3. Prototype Evidence (measured, not hypothetical)

`node .cursor/plans/llm-normalize-prototype/prototype.mjs` — one batch of 22 real
records from `reddit_carnivals`, `rick_steves`, `global_carnivalist`,
`musicfestivalwizard`, `festivism`, `edm_dance_directory` through
`deepseek-ai/DeepSeek-V4-Flash`, temperature 0. Results (`results.json`):

**Correct behavior observed:**

- "Trinidad Carnival 2026" → name "Trinidad Carnival", `edition_year: 2026`,
  `country_code: "TT"` (from `country: "Trinidad"`).
- "St.Maarten Carnival 2026" → `country_code: "SX"`, inverted range
  April 30 → **May 1** repaired (source said end "April 1").
- "Through May 29, 2026" → `end_date` only, no invented start.
- `20260820` compact dates and prose "February 16-17" both normalized.
- All 3 EDM directory club nights rejected (`invalid_reason: "club_night"`); the
  region-level Reddit row "Carnaval (North Brabant)" rejected (`region_not_poi`);
  defunct "10000 Lakes Festival 2009" normalized with correct 2009 dates.
- Alternates extracted ("Mas Dominik", "Summer Carnival"); Cyrillic/Greek names kept
  untranslated; `geocode_hint` sensible for every valid row.

**Failure modes found (each has a §6 guardrail):**

- "Tampa Bay 2026" (a real carnival, sparse record) was marked `is_poi: false`
  at confidence 0.3 → invalidation must require a confidence floor.
- Boilerplate descriptions leaked through ("National Carnival Commission.") →
  description length/content validation, and low-value strings nulled.

**Cost/latency (measured):** 4,139 prompt + 4,813 completion tokens, $0.00124 for
22 records ≈ **$0.000056/record**. Single-request latency was high (194 s ≈ 9 s/record
serial), so throughput comes from concurrency: 8 parallel batches of 25 →
~100k records in roughly half a day, ~$5.60. The full `docs/poi/` backlog
(~150–200k messy rows after MusicBrainz filtering) is ≲ $15 of LLM spend.

## 4. Schema Changes

One migration (`lib/db-map/migrations/2026….sql`, then `pnpm db:sync`).

**New columns on `research_pois`** (only fields consumed by downstream stages get
columns; the rest ride in `attributes.llm`):

```sql
ALTER TABLE research_pois
  ADD COLUMN name_display text,          -- LLM canonical name (edition year stripped)
  ADD COLUMN edition_year integer,
  ADD COLUMN venue text,
  ADD COLUMN geocode_hint text,
  ADD COLUMN description_normalized text,
  ADD COLUMN defunct boolean,
  ADD COLUMN invalid_reason text,        -- promoted from attributes (also set by QID rule)
  ADD COLUMN llm_confidence real;
```

`attributes.llm` gets: `name_alternates`, `recurrence`, `kind`, `notes`,
`prompt_version`. Existing progress semantics unchanged: `name_normalized IS NULL`
still selects rows to normalize; Phase C sets it last (from
`normalizeName(name_display ?? name)`).

**New cache table:**

```sql
CREATE TABLE research_llm_normalizations (
  content_hash   text NOT NULL,
  prompt_version text NOT NULL,
  model          text NOT NULL,
  output         jsonb NOT NULL,        -- validated LLM object, verbatim
  tokens_in      integer,
  tokens_out     integer,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, prompt_version, model)
);
```

Keyed on `content_hash` (not row id) so re-extracts, `--reflow`, and identical records
appearing in multiple files all hit cache. Bumping `PROMPT_VERSION` naturally re-runs
everything without deleting history; old versions can be pruned later.

**`reflow.ts`** additionally nulls the new columns (but never touches the cache table —
that is the point of it).

## 5. Per-Source Policy

Add to `SourceMeta` in `sources.ts`:

```ts
llm_normalize?: "full" | "gap_fill" | "off";   // default "full"
```

- `full` — every row goes through Phase B (all scraped directories, blogs, Reddit).
- `gap_fill` — only rows failing a deterministic completeness check (missing
  country_code/city, prose in date fields, name matching `/\b(19|20)\d{2}\b/`,
  website domain == source_url domain). For semi-clean sources like `thecraftmap`,
  `ticketmaster`.
- `off` — structured databases where the LLM adds nothing: `bgci`, `wikidata`, `osm`,
  `ridb`, `osm_camp`. Phase A + C only, exactly today's behavior.

This is the cost lever; the default is maximal LLM use per the product goal.

## 6. Guardrails (Phase C validation)

Every LLM object is validated field-by-field before writing; a failed field is dropped
individually (row falls back to deterministic value for that field), a failed object
drops the whole row to deterministic-only and logs it.

| Field | Validator |
| --- | --- |
| whole object | strict schema (zod), correct `idx`, one output per input; batch mismatch → bisect batch and retry halves (isolates poison rows) |
| `is_poi: false` | applied only when `confidence ≥ 0.7`; below that the row stays valid and gets `attributes.llm.needs_review = invalid_reason` (fixes the Tampa Bay false negative) |
| `name` | non-empty; must share ≥ 1 token with raw name (no hallucinated renames); else fall back to raw name |
| `country_code` | must be a valid ISO 3166-1 alpha-2 code |
| `start/end_date` | parseable ISO, start ≤ end, year within [1900, now+3]; else null |
| `website` | URL parses; its domain (or full URL) must appear **somewhere in the raw record** — LLM may only select, never invent; domain must differ from `source_url` domain and not be on a small listing-domain blocklist (ra.co, reddit.com, facebook events, known directories) |
| `description` | ≤ 600 chars; must not contain URLs absent from the record (same guard as description fusion); strings < 30 chars or equal to raw boilerplate fields are nulled |
| coordinates | LLM outputs none by design; `lat`/`lng` are untouchable by this stage |
| `edition_year` | integer within [1900, now+3] |

Determinism/ops: temperature 0; batches of 25 with 8-way concurrency (both
env-tunable); graceful Ctrl-C between batches (same pattern as match); per-run token
and cost counter printed in the summary line; on LLM/network error the row is left
un-normalized (`name_normalized` stays NULL) so the next run retries — never
half-written.

## 7. Downstream Integration

Small, targeted changes so the cleaner research rows actually improve canonicals:

1. **Matching** — no code change needed for blocking: `name_normalized` is now derived
   from the edition-stripped `name_display`, so "X Festival 2025" and "X Festival 2026"
   block and score as the same name. `edition_year`/dates continue to flow into
   `canonical_poi_occurrences` as today. `name_alternates` optionally added as a name
   signal later (not in first cut).
2. **Geocode** — `buildQuery` prefers `geocode_hint` when present (events already
   locality-only; the hint is strictly better than concatenated raw fields). Falls back
   to current construction.
3. **Embed** — embed text uses `name_display ?? name_normalized` + filled city/region;
   no structural change.
4. **Election (`merge.ts`)** — `chooseText` inputs switch to
   `name_display ?? name` and `description_normalized ?? description` (trust order
   unchanged). Rows with `defunct = true` are excluded from representative-date
   election; a canonical whose rows are all defunct gets `attributes.defunct = true`
   (publish policy for it decided with Workstream E's city-precision decision).
5. **Validity gate** — unchanged mechanically (`is_poi = false` rows never normalize
   /match), now actually populated by the LLM instead of only the QID rule.
6. **Dates** — `normalize/dates.ts` prose-LLM fallback is removed for LLM-policy
   sources (subsumed by Phase B); deterministic parsers remain as Phase C validators
   and as the `--no-llm`/`off` path.

## 8. Implementation Steps

1. **Migration + sync** — new columns, cache table, reflow update (§4). Commit
   `schema/` + `generated/` per repo rules.
2. **`normalize/llm.ts`** — prompt (versioned, extracted from prototype), batch
   builder (compact raw record projection: drop nulls, cap description at ~1k chars,
   include `ingest_category` + today's date for edition/date reasoning), DeepInfra call
   via existing `chat()` with `maxTokens` sized to batch (~400/row), JSON parse +
   fence stripping, zod schema, bisect-retry.
3. **`normalize.ts` restructure** — Phase A (existing transforms), Phase B (cache
   lookup → batched calls → cache write), Phase C (validators + single UPDATE per
   row). New flags: `--llm-only-pending` not needed (progress column covers it);
   keep `--source`, `--limit`, `--no-llm`; add `--concurrency`, `--batch-size`.
4. **`sources.ts`** — add `llm_normalize` policy per source (§5 values).
5. **Downstream touches** — geocode `buildQuery` hint, merge election preferences,
   embed text, dates fallback removal (§7). Each is a ≤ 20-line change.
6. **Eval harness** — promote the prototype into
   `lib/db-map/scripts/ingest/normalize/llm-eval.ts` + a checked-in golden file of
   ~40 records with expected key fields (is_poi, country_code, edition stripping,
   website demotion). Run manually when touching the prompt; prevents silent prompt
   regressions.
7. **Validation runs** (in order, each ending with `ingest:report`):
   a. `global_carnivalist` + `rough_guides` (small, custom extractors exist).
   b. `reddit_carnivals` + `rick_steves` via generic extractor (needs tiny
      spec-conformant siblings or field-alias additions — separate from this plan's
      scope if extractors are missing).
   c. `musicfestivalwizard` (9.6 MB, ~10k rows) — the real test: edition collapse
      into occurrences, defunct handling, listing-URL demotion at scale.
   d. Re-run normalize on all of the above → assert **zero** LLM calls (cache) and
      zero row changes (idempotency).

Explicitly out of scope: `ingest:run` orchestrator (Workstream A), city-precision
publish policy (Workstream E decision), new extractors for wrapper-format files,
re-processing the already-clean garden sources (`off` policy).

## 9. Acceptance Criteria

- `musicfestivalwizard` run: ≥ 95% of valid rows end with usable `city` + ISO
  `country_code`; editions of the same festival land on one canonical with multiple
  `canonical_poi_occurrences`; zero listing-domain URLs in canonical `website`.
- Club nights / articles / regions from the EDM + Reddit sources are `is_poi = false`
  with reasons; no valid festival is invalidated at confidence < 0.7.
- Canonical description coverage for LLM-normalized sources materially exceeds the
  current garden baseline (29% of published canonicals) — target ≥ 70% where any
  source row had prose.
- Rerunning `ingest:normalize` on unchanged rows: 0 LLM calls, 0 writes.
- `--no-llm` and `llm_normalize: "off"` sources behave byte-identically to today.
- Full-run LLM spend for the current `docs/poi/` backlog ≤ $25 (measured basis: §3).

## 10. Open Questions for Review

1. **Confidence floor** for applying `is_poi = false` — proposed 0.7. Too strict rows
   just stay in the pipeline (status quo); too loose loses real POIs.
2. **Defunct events** — hide canonicals that are entirely defunct, or publish with a
   badge? (Interacts with the Workstream E city-precision decision; proposal: hide
   for now, revisit with the date-filter UI.)
3. **`gap_fill` tier** — worth the extra code path, or start with just `full`/`off`
   and add it if cost ever matters? (Proposal: start with `full`/`off`.)
4. Should `description_normalized` also be generated for clean sources (`off` →
   at least description cleanup for BGCI's 1,224 prose descriptions)? Cheap win but
   expands scope.
