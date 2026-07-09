# Plan: POI Ingestion Remaining Work

> Status: new follow-up plan, created after completed implementation plans were moved into
> living documentation. This file tracks only unfinished POI ingestion work that still matters.
>
> Deliberately excluded: deferred canonical rebuilds and deterministic batch passes. Those
> were considered and dropped because the current row-at-a-time matcher is simpler, safer,
> and maintainable enough for the current data sizes.

---

## 1. Current Baseline

Implemented:

- Two-layer `research_*` -> `canonical_*` schema.
- Code-owned taxonomy and `ingest:taxonomy:seed`.
- Source extraction framework and real extractors for botanical garden and carnival sources.
- Normalize, geocode, embed, match, override, reflow, centroid seed, and Wikidata coordinate
  backfill scripts.
- Aggressive POI conflation rules, canonical consolidation, `--consolidate-only`, startup
  match progress banner, and graceful first `Ctrl-C`.
- Event date storage and representative occurrence rebuilds.
- API support for category filtering and `from`/`to` event-date query params.
- Living docs in `README.md`, `AGENTS.md`, `lib/db-map/README.md`, and
  `docs/poi-ingestion.md`.

Still unfinished:

- No one-command ingestion orchestrator.
- No first-class reconciliation report or run metrics.
- Legacy direct importers still write straight to canonical tables.
- Several registered source families have no extractors.
- No full end-to-end validation artifact across gardens, campgrounds, and festivals.
- No map UI for choosing an event date range.

---

## 2. Goals

1. Make real ingestion easier to run repeatedly with a single orchestration command.
2. Give operators a clear reconciliation report after each source/category run.
3. Move legacy curated imports toward the same provenance-preserving staging path.
4. Finish source extractor coverage for the next priority categories.
5. Produce an end-to-end validation record proving idempotent, de-duplicated ingestion across
   multiple categories.
6. Add the small app UI needed to use already-supported event date filtering.

Non-goals:

- Do not add a human review queue.
- Do not enforce licensing gates in the POC.
- Do not revive deferred rebuilds or deterministic batch passes.
- Do not introduce PostGIS, pgvector, queues, or new infrastructure.

---

## 3. Workstream A — `ingest:run` Orchestrator

Build `lib/db-map/scripts/ingest/run.ts` and package script:

```json
"ingest:run": "tsx scripts/ingest/run.ts"
```

Command shape:

```bash
pnpm --filter @lib/db-map ingest:run <source-slug> <file> --category <category-slug>
pnpm --filter @lib/db-map ingest:run <source-slug> <file> --category <category-slug> --limit 500
pnpm --filter @lib/db-map ingest:run <source-slug> <file> --category <category-slug> --dry-run
pnpm --filter @lib/db-map ingest:run <source-slug> <file> --category <category-slug> --no-llm
```

Behavior:

1. Validate source slug and category before writing anything.
2. Run stages in order:
   - `ingest:extract`
   - `ingest:normalize --source`
   - `ingest:geocode --source`
   - `ingest:embed --source`
   - `ingest:match --source`
   - `ingest:match --consolidate-only`
3. Pass relevant flags through:
   - `--limit` applies to extract and match only, unless a better per-stage convention is
     added.
   - `--dry-run` prevents writes in every stage that supports it.
   - `--no-llm` applies to normalize and match.
   - `--geocode-limit N` applies to geocode.
4. Stop on first failed stage.
5. Print the exact command for resuming manually.

Acceptance:

- Missing `--category` exits non-zero before writing.
- Unknown source exits non-zero before writing.
- Unknown category exits non-zero before writing.
- A small `--limit 10 --dry-run` run executes the chain without writes.
- A real small source run completes and leaves linked canonicals.

---

## 4. Workstream B — Reporting and Metrics

Add a reconciliation report that can run standalone and at the end of `ingest:run`.

Command shape:

```bash
pnpm --filter @lib/db-map ingest:report
pnpm --filter @lib/db-map ingest:report --source <source-slug>
pnpm --filter @lib/db-map ingest:report --category <category-slug>
```

Report should include:

- research rows by source and category
- match-ready pending rows
- not-ready rows split by missing coords/name/category
- linked rows
- canonical count
- published vs hidden canonical count
- match decisions by method
- LLM decisions count
- geocode cache hits/misses if cheap to compute
- popularity distribution
- top sources contributing to published canonicals

Optional database table:

```sql
ingest_runs (
  id uuid primary key,
  source_slug text,
  category_slug text,
  started_at timestamptz not null,
  finished_at timestamptz,
  status text not null,
  stats jsonb not null default '{}'
)
```

Keep `ingest_runs` optional unless it materially helps operations; a useful report command is
the priority.

Acceptance:

- `ingest:report` runs without mutating data.
- `ingest:run` prints a final report.
- Report output is compact enough to paste into a PR or run log.

---

## 5. Workstream C — Legacy Importer Migration

Current legacy commands:

```bash
pnpm db:import:kml ...
pnpm db:import:json ...
```

They still write directly to `canonical_pois`. Keep them available for small fixtures, but
add a provenance-preserving staged path for curated/manual data.

Preferred direction:

1. Add a `manual` or `curated` research source definition.
2. Add staged import mode:
   ```bash
   pnpm db:import:json <file> --source manual --category <slug> --staged
   pnpm db:import:kml <file> --source manual --category <slug> --staged
   ```
3. Staged imports write `research_pois` rows and then use the normal normalize/match path.
4. Keep direct canonical writes only behind explicit `--direct-canonical` or document them as
   fixture-only.

Acceptance:

- Curated JSON/KML can flow through `research_pois`.
- Staged curated rows have source provenance.
- Existing fixture workflows still work or have a clear replacement.
- `lib/db-map/IMPORTING.md` and `docs/AGENTS.md` describe the new primary path.

---

## 6. Workstream D — Source Extractor Coverage

The source registry currently has metadata-only entries for campgrounds and festivals.

### Campgrounds

Registered but missing extractors:

- `ridb`
- `thedyrt`
- `osm_camp`
- `uscampgrounds`

Priority:

1. `ridb` facilities, because trust is highest and source data is structured.
2. `uscampgrounds`, because it is smaller and useful as a seed/cross-check.
3. `thedyrt`, because it is large and lower-trust but broad.
4. `osm_camp`, after deciding whether to reuse the generic OSM extractor or specialize.

Acceptance:

- Each extractor emits stable `source_record_id`.
- RV/campground-specific fields land in attributes.
- Records with source coordinates do not require geocoding.
- Campsite-level data does not accidentally flood the map with individual campsite pads
  unless the category being ingested explicitly calls for that.

### Festivals

Registered but missing extractors:

- `musicbrainz`
- `ticketmaster`
- `resident_advisor`
- `musicfestivalwizard`
- `edm_dance_directory`
- `jambase`
- `viberate`
- `songkick`
- `festivism`
- `festivalatlas`

Priority:

1. `resident_advisor`, because dates/country coverage are strong and it exercises temporal
   POIs.
2. `musicfestivalwizard`, because it is a focused festival directory.
3. `musicbrainz`, because it is large and structured but may need careful event filtering.
4. `edm_dance_directory`, after preserving the existing validity gate so clubs/venues do not
   become festivals.

Acceptance:

- Event dates populate `starts_at`, `ends_at`, and `date_precision` where available.
- Directory/listing URLs are not promoted to official `website` when they are only source
  provenance.
- Non-POI rows are filtered before matching.
- Recurring editions collapse into a single canonical when appropriate.

---

## 7. Workstream E — End-to-End Validation

Create a repeatable validation record for at least:

- botanical gardens
- campgrounds/RV parks
- music festivals

Suggested process:

1. Run a small representative source set per category.
2. Capture command transcript or summarized report output.
3. Run SQL checks:
   - duplicates collapsed
   - popularity reflects distinct source count
   - categories populated
   - field provenance populated
   - not-ready rows are understood
   - event rows have dates where expected
4. Re-run the same commands and confirm idempotency.
5. Start the app and manually inspect dense map regions plus detail drawers.
6. Save findings under `docs/poi/<category>/VALIDATION.md` or a consolidated
   `docs/poi-ingestion-validation.md`.

Acceptance:

- Validation document exists.
- It includes exact commands, counts, known caveats, and screenshots if useful.
- At least one multi-source category proves de-duplication and provenance end to end.

---

## 8. Workstream F — Event Date Filter UI

Backend support exists: `/api/pois` accepts `from` and `to`, and SQL filters event ranges
while keeping permanent POIs visible.

Remaining app work:

- Add a compact date-range control to the map UI.
- Send `from` and `to` params with POI bbox requests.
- Make the control visible only when useful, or harmless for all categories.
- Preserve current map ergonomics on mobile.

Acceptance:

- Choosing a date range changes `/api/pois` requests.
- Event POIs outside the range disappear.
- Permanent POIs remain visible.
- The detail drawer still renders event dates and status.

---

## 9. Suggested Order

1. `ingest:report`
2. `ingest:run`
3. RIDB campground extractor
4. Resident Advisor festival extractor
5. Validation docs for gardens + first campground/festival slices
6. Staged legacy importer path
7. Event date filter UI
8. Additional extractors by priority

Reasoning:

- Reporting helps every later task.
- The orchestrator reduces operator error once report output exists.
- One campground and one festival extractor prove the remaining category-specific paths.
- Legacy importer migration is useful but not blocking real source ingestion.
- Date filter UI is product-visible but not a blocker for ingestion correctness.

