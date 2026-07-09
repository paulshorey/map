# Plan: LLM-Powered Research POI Normalization

> Status: implementation plan (2026-07-09). Replaces the narrow "Workstream D — LLM Triage"
> scope in `poi-ingestion-unfinished-work.md` with a full enrichment architecture.
>
> Model: **DeepSeek-V4-Flash** via DeepInfra (`ingestConfig.llm`, already default).
> Goal: produce **match-ready, high-quality `research_pois`** so canonical election and map
> display inherit clean locality, names, dates, and validity — without per-source cleanup code.

---

## 1. Problem Statement

The pipeline correctly preserves messy raw capture in `research_pois.raw` and
`attributes`, but **normalize today is almost entirely deterministic**. It handles
name lowercasing, phone/domain cleanup, centroid rules, and prose dates — and rejects
only bare Wikidata QID names. Everything else passes through with source errors intact.

That design made sense when most imported data was structured (BGCI, Wikidata, OSM).
The next wave — carnival scrapes, festival directories, campground composites, Wikipedia
table pollution — needs interpretation the deterministic layer cannot safely provide.

### Measured gaps (baseline audit, 2026-07-09)

Helper: `pnpm --filter @lib/db-map ingest:analyze-gaps [--source <slug>]`

**`global_carnivalist` (25 rows, post-current-normalize):**

| Signal | Rate | Impact |
|--------|------|--------|
| `country_name` present, `country_code` null | **68%** | Geocode locality score wrong; FL/USVI/Trinidad stored as "countries" |
| Edition year still in `name_normalized` | **88%** | Same carnival series won't merge across editions |
| `has_country_code` overall | **20%** | Miami row has `country_code=FL`; Tampa has `country_code=FL` |
| `has_coords` | **0%** | All depend on geocode quality of city/region/country |
| `has_starts_at` | **96%** | Dates OK for this source (deterministic + swap repair) |

**`botanical_garden` (9,872 POI rows, gardens only):**

| Signal | Rate | Impact |
|--------|------|--------|
| Missing `city` where only `attributes.country_name` | **~hundreds** | Geocode must infer city from garden name alone |
| Missing `country_code` with `country_name` | **non-trivial** | ArbNet/IABG-style name+URL-only rows |

**Downstream cost of messy research rows:**

1. **Geocode** — weak queries (`"Dubai"`, `"Hollywood Blvd, Los Angeles"`) → city centroids or misses.
2. **Match** — edition years in `name_normalized` → duplicate canonicals per year; bad locality → wrong spatial candidates.
3. **Canonical rebuild** — `coordinate_precision = city/region` → **`hidden`** canonicals (962/7,314 gardens today).
4. **Embed** — `name_normalized + city + region + category`; empty city loses semantic signal.
5. **LLM match** — more gray-zone pairs because research rows arrive incomplete.

The fix belongs **before geocode/embed/match**, in an expanded normalize stage — not in
match or merge. Match LLM should adjudicate ambiguity, not repair bad locality.

---

## 2. Design Principles

1. **Capture verbatim; enrich separately.** LLM output never overwrites `name`, `raw`, or
   source-captured columns. It fills normalized columns and `attributes.enrichment`.
2. **Deterministic first.** Run existing rules; call LLM only when gate functions say a row
   needs enrichment (or when `--force-llm` is set for reprocessing).
3. **Batch for cost and context.** 20–50 rows per prompt; shared category context per batch.
4. **Strict JSON out.** Zod (or equivalent) validation; reject batch on schema mismatch;
   retry once with repair prompt; then skip rows and log.
5. **Cache everything.** Key: `(content_hash, enrichment_version, batch_fingerprint)`.
   Reruns and `--reflow` on unchanged rows = **zero LLM calls**.
6. **`--no-llm` skips all enrichment.** Rows keep today's deterministic behavior.
7. **Versioned prompts.** `enrichment_version` in cache; bump when prompt/schema changes.
8. **Auditable.** Every applied field records `enrichment_source: "llm"` and confidence
   in `attributes.enrichment` (mirrors `date_source: "llm"` pattern).

---

## 3. Architecture Overview

Refactor `ingest:normalize` into **three phases** in one command (no new top-level stage
initially — avoids orchestrator churn; can split to `ingest:enrich` later if needed).

```
┌─────────────────────────────────────────────────────────────────┐
│  ingest:normalize [--source] [--limit] [--no-llm] [--force-llm] │
└─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────┐
│ Phase 1: Deterministic │  Existing: name/phone/domain/coords/dates/country/centroids
│ (always runs)          │  NEW: cheap pre-passes (year strip heuristic, US state→region)
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│ Phase 2: Gate + Batch │  Select rows needing LLM; group by ingest_category; batch 30
│ LLM Enrichment        │  Check cache; call DeepInfra; validate JSON
└─────────────────────┘
         │
         ▼
┌─────────────────────┐
│ Phase 3: Apply        │  Merge enrichment into columns + attributes.enrichment
│ + Finalize            │  Set geocode_query_norm; mark is_poi; write name_normalized
└─────────────────────┘
```

### New modules (under `lib/db-map/scripts/ingest/normalize/`)

| Module | Responsibility |
|--------|----------------|
| `enrich/gates.ts` | `needsEnrichment(row, phase1Result): boolean` + reason codes |
| `enrich/prompt.ts` | System prompt, batch user payload builder, category context |
| `enrich/schema.ts` | Zod schemas for per-row LLM output |
| `enrich/batch.ts` | Batch split/merge, cache read/write, API call, retry |
| `enrich/apply.ts` | Apply validated output to DB columns (conservative merge rules) |
| `enrich/query.ts` | Build `geocode_query_norm` from enriched locality |

Wire from `normalize.ts` after Phase 1 per-row loop **or** as a second pass over rows
where `attributes.enrichment_version` is stale (cleaner for batching: **collect Phase 1
results, then one batch pass**).

### Cache table (new migration)

```sql
CREATE TABLE research_normalize_cache (
  content_hash       text NOT NULL,
  enrichment_version smallint NOT NULL DEFAULT 1,
  model              text NOT NULL,
  prompt_hash        text NOT NULL,   -- sha256 of system prompt + schema
  response_json      jsonb NOT NULL,  -- validated LLM output for this row
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (content_hash, enrichment_version)
);
CREATE INDEX research_normalize_cache_created ON research_normalize_cache (created_at);
```

Alternative: store in `attributes.enrichment` only (no table). **Use the table** — keeps
`attributes` smaller, makes cache inspection easy, and survives attribute merges.

---

## 4. LLM Enrichment Contract

### Input payload (per row, sent in batch array)

Send a compact snapshot — not the full `raw` blob:

```jsonc
{
  "id": "uuid",                        // research_pois.id — round-trip only
  "ingest_category": "carnival",
  "name": "Trinidad Carnival 2026",
  "description": "National Carnival Commission",
  "city": "Port of Spain",
  "region": null,
  "country_code": null,
  "country_name": "Trinidad",          // from attributes
  "address": null,
  "venue": null,
  "location_raw": "Port of Spain, Trinidad",
  "website": "https://www.ncctt.org/new/",
  "source_url": "https://globalcarnivalist.com/...",
  "raw_category": "carnival",
  "start_date": "February 16, 2026",
  "end_date": "February 17, 2026",
  "date_text": "February 16-17",
  "also_known_as": null,
  "hints": ["country_name_unresolved", "edition_year_in_name"]
}
```

`hints` comes from Phase 1 gate codes — steers the model without hard-coding per source.

### Output schema (per row)

```jsonc
{
  "id": "uuid",
  "is_poi": true,
  "invalid_reason": null,              // required when is_poi=false

  "series_name": "Trinidad Carnival",  // display series without edition
  "edition_year": 2026,                // null if not an edition-specific record
  "alt_names": ["Sugar Mas"],          // from also_known_as / description

  "city": "Port of Spain",
  "region": null,
  "country_code": "TT",
  "address": null,
  "venue": null,

  "phone": null,
  "website": "https://www.ncctt.org/new/",  // official only; null if unsure
  "email": null,

  "starts_at": "2026-02-16",           // ISO date; null if unknown
  "ends_at": "2026-02-17",
  "date_precision": "day",             // day|month|year
  "dates_verbatim": "February 16-17",

  "wikidata_id": null,
  "osm_type": null,
  "osm_id": null,

  "description_clean": null,           // HTML stripped, 1-2 sentences max; null to keep raw
  "poi_subtype": "carnival",           // free hint: campground|rv_park|club_night|art_fair|…

  "confidence": {
    "is_poi": 0.95,
    "locality": 0.9,
    "dates": 0.85,
    "name": 0.95
  }
}
```

### Apply rules (Phase 3)

| Field | Rule |
|-------|------|
| `is_poi` | Set `false` only when `is_poi=false` AND `confidence.is_poi ≥ 0.8` OR `invalid_reason` present |
| `name_normalized` | From `series_name` (normalized) if present; else deterministic |
| `name` column | **Never overwrite** (verbatim capture) |
| `city`, `region`, `country_code` | Fill only when currently null OR gate flagged bad value (e.g. `FL` as country) |
| `address`, `venue` | Write `venue` to `attributes.venue`; `address` to column if null |
| `phone`, `website`, `email` | Fill null columns only; never replace non-null source values |
| `starts_at`, `ends_at`, `date_precision` | Fill when Phase 1 left null; Phase 1 wins if already set |
| `attributes.edition_year`, `series_name`, `alt_names` | Always from LLM when provided |
| `attributes.enrichment` | `{ version, model, applied_at, confidence, hints_resolved }` |
| `geocode_query_norm` | Built after apply via `enrich/query.ts` — **do not leave NULL** when geocode needed |

**Bad-value replacement:** When `country_code` matches a known US state list and
`ingest_category` is temporal → move to `region`, resolve `country_code=US`. Same for
AU states, CA provinces (extend deterministic list; LLM confirms edge cases).

---

## 5. Enrichment Tasks (full scope)

Ordered by ROI. All are **one batched prompt** per category — the model returns all fields
it can infer; gates decide whether a row enters the batch.

### 5.1 Validity (`is_poi`)

Classify rows that are not map POIs:

- Directory/nav pages (`"Events"`, `"test"`)
- Articles, regions, organizations, tour packages
- Club nights in festival directories (`is_festival: false`)
- Theatres/zoos in garden lists
- Campsite-level records (parent facility only)
- Mobile home parks tagged `caravan_site`

Sets `is_poi = false`, `attributes.invalid_reason`, skips geocode/embed/match.

### 5.2 Name canonicalization

- Strip edition years (`2026`, `'26`) → `series_name` + `attributes.edition_year`
- Strip boilerplate (`Festival`, `Carnival` duplication, ticket vendor suffixes)
- Extract `alt_names` from `also_known_as`, parentheticals, description
- Produce matching-grade `name_normalized` from `series_name`

**Critical for:** MusicBrainz, FestApp, Global Carnivalist, Festifeed, eFestivals.

### 5.3 Locality extraction

Parse free-text into structured hierarchy:

- `location_raw`, `location`, combined `city` fields (`"Eichenring Scheeßel , DE 27383"`)
- Island/territory as country (`St.Croix` → US, region `VI`)
- US state as country (`Florida` → US, region `FL`)
- Australian `NSW` as region, country `AU`
- Street in city (`"Hollywood Blvd, Los Angeles"` → address + city)
- Venue blobs → `venue` + parsed `city`

**Critical for:** Global Carnivalist, FestApp, ThatFestivalSite, Rough Guides, Artsy fairs.

### 5.4 Date enrichment (extend existing)

Keep `normalize/dates.ts` deterministic path. LLM batch handles rows where:

- Deterministic returned null but prose exists
- Year missing from `date_text` (infer from `edition_year`, `month_group`, scrape context)
- Recurring phrases (`"every February"`, `"February–March"`) → month precision window
- Inverted start/end (LLM flags; Phase 1 swap repair still runs)

Unify with batch output; retire standalone per-row prose LLM in `dates.ts` once batch
covers it (or keep as fast path for single-row reruns).

### 5.5 Contact & URL disambiguation

- Strip HTML from descriptions; detect phone/email in composite fields (RIDB, uscampgrounds)
- `website` vs `source_url`: official organizer domain vs RA/Ticketmaster listing
- Reject social/directory domains for `website` (align with match denylist)

### 5.6 Strong ID extraction

Scan `description`, `website`, `source_url`, `raw` for:

- Wikidata QID patterns
- OSM `node/123` URLs
- MusicBrainz MBID in text

Write to `attributes` for `strong_id` match cascade — zero-cost merges later.

### 5.7 Category-specific attributes (not taxonomy)

Parse structured hints into `attributes` without changing `category_slugs`
(still from `--category` at extract):

| Category | Examples |
|----------|----------|
| campground | `hookup_type`, `max_vehicle_length_ft`, `num_sites`, `season_dates_verbatim` |
| music_festival | `genres`, `capacity_tier`, `indoor_outdoor` |
| carnival | `caribbean_region`, `is_caribbean_carnival` |
| art_fair | `fair_type` (contemporary, antique) |

### 5.8 Geocode query precomputation

Set `geocode_query_norm` explicitly after enrichment:

| Category kind | Query shape |
|---------------|-------------|
| Temporal (festival, carnival, art_fair) | `venue, city, region, country` — **exclude event name** |
| Place (garden, campground) | `name, city, region, country` |

Geocode stage prefers `geocode_query_norm` when set (small change to `geocode.ts`).

### 5.9 Embedding text refresh

After enrichment, if `city`/`region`/`country_code` or `name_normalized` changed vs
Phase 1, clear `content_embedding` so `ingest:embed` recomputes. Option: embed inline at
end of normalize (defer — keep embed separate).

---

## 6. Gate Functions (when to spend LLM)

A row enters the LLM batch when **any** of:

```typescript
// gates.ts — illustrative
needsEnrichment(row, d1): boolean
```

| Code | Condition |
|------|-----------|
| `missing_country` | `!country_code && (country_name \|\| location_raw)` |
| `bad_country` | `country_code` is US state / AU state / known territory token |
| `edition_in_name` | `/\b20\d{2}\b/` in name and temporal category |
| `street_in_city` | city looks like address |
| `missing_city` | `!city && (location_raw \|\| venue \|\| address)` |
| `missing_dates` | temporal category + no `starts_at` + date text in attributes |
| `prose_dates` | date text failed deterministic parse |
| `suspect_poi` | name in `EVENTS`, `test`, `TBD`; or raw_category signals |
| `composite_blob` | known composite attribute keys (uscampgrounds) |
| `html_description` | description contains `<` and missing locality |
| `force` | `--force-llm` CLI flag |

Rows passing **no gates** skip LLM entirely (common for BGCI/Wikidata/OSM with good coords).

Optional: **source-level default gate** for known-messy slugs (`global_carnivalist`,
`festapp`, `edm_dance_directory`, `fecc_carnivalcities`) — always enrich until cache warm.

---

## 7. Prompt Strategy

### System prompt (stable, versioned)

```
You normalize messy POI research records for a global map database.
Category context: {ingest_category} — {category_description}.

Rules:
- Output ONLY a JSON array matching the schema; one object per input id.
- is_poi=false for listings that are not a specific visitable place or event instance.
- series_name: human-readable name without year/edition/ticket boilerplate.
- country_code: ISO 3166-1 alpha-2. Territories: US for Guam/VI/PR; GB for Gibraltar; etc.
- Never invent coordinates. Never invent precise street addresses.
- website: official organizer/site only; not facebook, residentadvisor, ticketmaster listings.
- dates: ISO YYYY-MM-DD; use month precision when only month known.
- confidence: 0-1 per field group; omit fields you are unsure about (null).
```

### Batch sizing

- Default **30 rows** per request (`ENRICH_BATCH_SIZE` env, default 30)
- Max input ~8k tokens; truncate `description` to 400 chars in payload
- `max_tokens`: 4096 for batch response
- Group batches by `ingest_category` (shared context)

### Error handling

1. Schema validation fail → retry once with "your JSON was invalid: {zod errors}"
2. Second fail → log batch ids, skip, continue pipeline
3. Rate limit → exponential backoff (match stage pattern)
4. Partial batch: if array shorter than input, missing ids retry in next batch alone

---

## 8. Integration Points

### `normalize.ts` changes

1. After existing per-row deterministic loop, collect `{ id, row, d1Result }` for gated rows.
2. Run `enrichBatches()` → `applyEnrichment()`.
3. Extend stats: `enriched`, `llm_batches`, `cache_hits`, `invalid_marked`, `locality_filled`.
4. New flags: `--force-llm`, `--enrich-only` (skip deterministic except gates), `--enrich-batch-size N`.

### `geocode.ts` changes

```typescript
// Prefer pre-built query
const query = row.geocode_query_norm ?? buildGeocodeQuery(row);
```

### `embed.ts` changes

Select rows where `content_embedding IS NULL` **OR** `attributes.enrichment_version` changed
since last embed (track `attributes.embedded_enrichment_version`).

### `extract.ts` / `reflow.ts`

On `content_hash` change: delete cache entry for old hash; reset `attributes.enrichment`
and `geocode_query_norm`; existing derived-column reset unchanged.

### `ingest:report` additions

- `% research rows LLM-enriched`
- `% with geocode_query_norm`
- `is_poi=false` by `invalid_reason`
- Top `invalid_reason` counts

### `ingest:analyze-gaps` (implemented)

`lib/db-map/scripts/ingest/analyze-normalize-gaps.ts` — run before/after to measure progress.

---

## 9. Implementation Phases

### Phase 0 — Foundation (1–2 days)

- [ ] Migration: `research_normalize_cache`
- [ ] `enrich/schema.ts`, `enrich/gates.ts`, `enrich/batch.ts` skeleton
- [ ] Package script: `ingest:analyze-gaps`
- [ ] Golden fixtures: 10 rows × 3 categories (carnival, festival, garden) in
      `lib/db-map/scripts/ingest/normalize/enrich/fixtures.json`

### Phase 1 — Locality + Names (highest ROI, 2–3 days)

- [ ] Prompt + apply for `series_name`, `edition_year`, `city`, `region`, `country_code`
- [ ] US state / territory deterministic pre-pass
- [ ] `geocode_query_norm` builder
- [ ] Wire into `normalize.ts` Phase 2–3
- [ ] **Acceptance:** `global_carnivalist` full file → ≥95% `country_code`, 0% edition in `name_normalized`

### Phase 2 — Validity triage (1–2 days)

- [ ] `is_poi` / `invalid_reason` in schema + apply
- [ ] Extractor `isPoi` hooks for obvious flags (`is_festival: false`) — free wins without LLM
- [ ] **Acceptance:** FECC carnival cities sample → nav pages marked `is_poi=false`

### Phase 3 — Dates unification (1 day)

- [ ] Move prose date LLM into batch; keep deterministic first
- [ ] Recurring/month-precision handling
- [ ] **Acceptance:** Rough Guides + Wikipedia carnival articles → ≥80% `starts_at` for temporal rows

### Phase 4 — Contact, venue, composite blobs (2 days)

- [ ] uscampgrounds composite parser (deterministic regex + LLM fallback)
- [ ] RIDB HTML strip + facility type
- [ ] Website vs source_url disambiguation

### Phase 5 — Strong IDs + embed refresh (1 day)

- [ ] Wikidata/OSM/MBID extraction in batch
- [ ] Embed invalidation on enrichment version bump

### Phase 6 — Rollout + docs (1 day)

- [ ] Update `docs/poi-ingestion.md` normalize section
- [ ] Update `docs/poi-research/capture-spec.md` rule 8 (triage now implemented)
- [ ] Run full festival/carnival import runbook with enrichment enabled
- [ ] Capture before/after `ingest:analyze-gaps` in `docs/poi-ingestion-validation.md`

---

## 10. Cost Estimate

DeepSeek-V4-Flash via DeepInfra: ~$0.10–0.30 per million input tokens (order of magnitude).

| Scenario | Rows | Batches (30) | Est. tokens | Est. cost |
|----------|------|--------------|-------------|-----------|
| Global Carnivalist | 25 | 1 | ~3k | < $0.01 |
| FestApp | 1,796 | 60 | ~180k | < $0.05 |
| EDM directory | 9,901 | 330 | ~1M | ~$0.10–0.30 |
| MusicBrainz (16 files) | ~50k | 1,667 | ~5M | ~$0.50–1.50 |
| Full re-run (cached) | any | 0 | 0 | **$0** |

Batching + cache makes "maximize LLM use" economically viable. Prefer enriching all gated
rows over writing per-source extractors.

---

## 11. Testing Strategy

1. **Fixture tests** (`enrich/fixtures.json`): mock LLM returns canned JSON; assert apply rules.
2. **Gate tests**: each gate code triggers on known bad rows.
3. **Schema tests**: reject malformed LLM output.
4. **Integration**: extract 50 rows → normalize → analyze-gaps; compare to thresholds.
5. **Idempotency**: second normalize → 0 API calls, identical columns.
6. **Match golden**: `ingest:match:golden` still passes (no regression on gardens).

### Primary acceptance targets

| Source | Metric | Before | Target |
|--------|--------|--------|--------|
| `global_carnivalist` | `country_code` fill | 20% | ≥95% |
| `global_carnivalist` | edition in `name_normalized` | 88% | 0% |
| `festapp` (sample 200) | usable city+country | ~60% | ≥90% |
| `fecc_carnivalcities` | `is_poi` precision | 0% filtered | ≥90% junk rejected |
| Any | LLM calls on re-normalize | N/A | 0 |

---

## 12. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| LLM invents coords | Schema forbids lat/lng; geocode remains separate |
| LLM merges distinct events | Only fills fields; match stage still uses dates + scoring |
| Hallucinated websites | Denylist check on apply; prefer null over wrong |
| Batch validation flakiness | Retry + per-row fallback batch of 1 |
| Stale cache after prompt change | Bump `enrichment_version`; `--force-llm` reflow |
| Over-aggressive `is_poi=false` | Require `invalid_reason` + confidence threshold; audit in report |

---

## 13. Relationship to Other Workstreams

| Plan | Interaction |
|------|-------------|
| `poi-ingestion-unfinished-work.md` | Workstream D → **this plan**; implement Phase 1 before messy festival dirs |
| `poi-campgrounds-festivals-import.md` | Run imports with enrichment enabled; uscampgrounds/RIDB need Phase 4 |
| `ingest:run` orchestrator | Pass `--no-llm` through; report shows enrichment stats |
| Match/consolidate LLM | Unchanged — benefits from cleaner research rows (fewer gray-zone pairs) |

### Suggested order (updated)

1. City-precision publish policy (Workstream E decision) — still first for festivals.
2. **LLM normalize Phase 0–1** (this plan) — before large festival/carnival imports.
3. `ingest:run` orchestrator.
4. Campground/festival import runbook execution.
5. LLM normalize Phase 2–4 in parallel with imports.
6. End-to-end validation doc.

---

## 14. Open Questions

1. **Split command?** `ingest:enrich` vs inline normalize — start inline; split if normalize
   runtime exceeds ~10 min for large sources and operators want enrich-only reruns.
2. **Human review queue?** Out of scope; use `ingest:override` + `invalid_reason` audit for now.
3. **Multi-category rows?** Still single `--category` at extract; enrichment uses that context only.
4. **Non-English locality?** Model handles globally; add fixtures for JP/DE/FR carnival names.

---

## Appendix A: Example — Trinidad Carnival 2026

**Before (current normalize):**

```
name_normalized: "trinidad carnival 2026"
city: "Port of Spain"
country_code: null
country_name: "Trinidad"
starts_at: 2026-02-16
```

**After (LLM enrich):**

```
name_normalized: "trinidad carnival"
attributes.series_name: "Trinidad Carnival"
attributes.edition_year: 2026
city: "Port of Spain"
region: null
country_code: "TT"
geocode_query_norm: "Port of Spain, Trinidad and Tobago"
attributes.enrichment: { version: 1, model: "deepseek-ai/DeepSeek-V4-Flash", ... }
```

**Canonical impact:** editions 2025/2026/2027 merge via `name_normalized` + date compatibility;
geocode hits Port of Spain city centroid; occurrence rows carry per-edition dates.

---

## Appendix B: Files to Create/Modify

| Path | Action |
|------|--------|
| `lib/db-map/migrations/YYYYMMDD__research_normalize_cache.sql` | CREATE TABLE |
| `lib/db-map/scripts/ingest/normalize/enrich/*.ts` | New modules |
| `lib/db-map/scripts/ingest/normalize.ts` | Phase 2–3 wiring |
| `lib/db-map/scripts/ingest/normalize/dates.ts` | Optionally delegate prose to batch |
| `lib/db-map/scripts/ingest/geocode.ts` | Use `geocode_query_norm` |
| `lib/db-map/scripts/ingest/embed.ts` | Enrichment version invalidation |
| `lib/db-map/scripts/ingest/report.ts` | Enrichment stats |
| `lib/db-map/scripts/ingest/analyze-normalize-gaps.ts` | **Done** |
| `lib/db-map/package.json` | `ingest:analyze-gaps` script |
| `docs/poi-ingestion.md` | Document new normalize behavior |
| `.cursor/plans/poi-ingestion-unfinished-work.md` | Replace §6 with link |
