# Plan: POI Ingestion Remaining Work

> Status: living follow-up plan. Tracks only unfinished POI ingestion work that still
> matters. Updated 2026-07-09 after a code review of the implemented pipeline against the
> real source data in `docs/poi/`.
>
> Deliberately excluded (reviewed and reaffirmed): deferred canonical rebuilds and
> deterministic batch passes. The row-at-a-time matcher is simpler, safer, resumable, and
> fast enough at current sizes (~10k research rows matched in one sitting). The one real
> cost of rerunning — repeated anchor-vs-anchor LLM adjudication during consolidation — is
> now fixed much more cheaply by the consolidation decision memo (see baseline). Revisit
> batch passes only if a single category exceeds ~250k pending rows or matching throughput
> becomes the bottleneck in practice.

---

## 1. Current Baseline

Implemented (in addition to the previously documented baseline):

- Two-layer `research_*` → `canonical_*` schema; code-owned taxonomy; extract → normalize
  → geocode → embed → match → consolidate pipeline; aggressive conflation; event dates and
  occurrences; resumable match with startup banner and graceful Ctrl-C.
- **`ingest:report`** — read-only reconciliation report (rows by source/stage, match
  readiness, canonicals by category, decisions by method, geocode cache, popularity,
  event-date coverage). Run standalone, `--source`, or `--category`.
- **Consolidation decision memo** (`research_consolidation_decisions`) — anchor-vs-anchor
  LLM verdicts are stored per canonical pair and reused on later `--consolidate` runs.
  A verdict goes stale (re-adjudicated) only when either canonical is rebuilt with new
  data. Reruns of `--consolidate-only` on an already-consolidated database now take
  seconds and zero LLM calls (verified: first run 102 LLM calls / 6 min, rerun 0 calls /
  4 s).
- **Generic capture-spec extractor** — sources registered in `sources.ts` without a custom
  extractor fall back to a generic extractor for files following
  `docs/poi-research/capture-spec.md`. New conformant sources need only a metadata entry.

Still unfinished:

- No one-command ingestion orchestrator (`ingest:run`).
- Normalize is still a shallow rule pass with an LLM prose-date fallback; it does not
  produce a versioned, evidence-grounded interpretation of messy source rows. See the
  dedicated Workstream D plan.
- Publish policy for city-precision event coordinates is undecided; as implemented,
  festivals that geocode to a city centroid end up `hidden` (see Workstream E decision).
- Legacy direct importers still write straight to canonical tables.
- Campground and festival sources have no validated ingestion runs yet (several now work
  through the generic extractor; a few need small custom extractors — see the runbook plan
  `.cursor/plans/poi-campgrounds-festivals-import.md`).
- No full end-to-end validation artifact across gardens, campgrounds, and festivals.
- No map UI for choosing an event date range.

---

## 2. Goals

1. Make real ingestion easy to run repeatedly: one orchestration command per source.
2. Ingest the next two categories (campgrounds, music festivals) end to end, proving the
   temporal-POI path with real data.
3. Replace normalize with a cached, versioned LLM-native interpretation layer that turns
   lossless source capture into validated, high-quality research records.
4. Move legacy curated imports to the provenance-preserving staging path.
5. Produce an end-to-end validation record proving idempotent, de-duplicated ingestion
   across multiple categories.
6. Add the small app UI needed to use the already-supported event date filtering.

Non-goals (unchanged): no human review queue, no licensing gates in the POC, no deferred
rebuilds/batch passes, no PostGIS/pgvector/queues/new infrastructure.

---

## 3. Workstream A — `ingest:run` Orchestrator

Build `lib/db-map/scripts/ingest/run.ts` + package script `ingest:run`.

```bash
pnpm --filter @lib/db-map ingest:run <source-slug> <file> --category <category-slug> \
  [--limit N] [--dry-run] [--no-llm] [--geocode-limit N]
```

Behavior:

1. Validate source slug and category before writing anything.
2. Run stages in order: extract → normalize (`--source`) → geocode (`--source`) →
   embed (`--source`) → match (`--source`) → `match --consolidate-only`.
3. Pass flags through: `--limit` (extract + match), `--dry-run` (all stages that support
   it), `--no-llm` (normalize + match), `--geocode-limit` (geocode).
4. Stop on first failed stage and print the exact command to resume that stage manually.
5. Print `ingest:report --source <slug>` output at the end.

Implementation note: spawn the stage scripts as child processes (same commands the docs
teach) rather than importing their `main()`s — keeps each stage's CLI contract the single
interface and the orchestrator trivial.

Acceptance:

- Missing/unknown `--category` or unknown source exits non-zero before writing.
- A small `--limit 10 --dry-run` run executes the chain without writes.
- A real small source run completes, leaves linked canonicals, and ends with a report.

## 4. Workstream B — Reporting (mostly done)

`ingest:report` is implemented. Remaining, in priority order:

1. Print the report automatically at the end of `ingest:run` (part of Workstream A).
2. Optional `ingest_runs` history table — only if operating without it proves painful.
   The startup banner + report + `research_match_decisions` already cover most needs.

---

## 5. Workstream C — Legacy Importer Migration

Unchanged in direction: keep `db:import:kml` / `db:import:json` for small fixtures, add a
staged path for curated data.

1. Register a `manual` research source (trust ~90, "curated by operator").
2. `pnpm db:import:json <file> --source manual --category <slug> --staged` writes
   `research_pois` rows (the JSON already nearly conforms to the capture spec, so the
   generic extractor mapping can be reused).
3. Direct canonical writes stay available but are documented as fixture-only.

Acceptance: curated JSON/KML flows through `research_pois` with provenance;
`lib/db-map/IMPORTING.md` and `docs/AGENTS.md` describe the staged path as primary.

---

## 6. Workstream D — LLM-Native Research Normalization

This is now a standalone architecture and implementation workstream:
`.cursor/plans/poi-llm-normalization.md`.

It replaces the proposed three-field triage with a versioned DeepSeek interpretation layer
for validity, identity/edition handling, locality, multiple occurrences, URL/contact roles,
descriptions, taxonomy-constrained categories, and typed attributes. Captured records remain
immutable; deterministic evidence validation gates model output; downstream geocode/embed/
match consume only an accepted active normalization. The plan also adds cached canonical
synthesis after matching.

Implement it before importing the messier directory, article, campground, and art-fair
sources. Its golden-set and shadow-mode phase should precede the full pipeline cutover.

---

## 7. Workstream E — Campground + Festival Ingestion

Detailed per-source commands, file paths, and gotchas live in the runbook:
`.cursor/plans/poi-campgrounds-festivals-import.md`. Summary of order:

Campgrounds: 1) `ridb` facilities (custom extractor: HTML descriptions, keywords; use
`facilities.csv`, never campsite-level files), 2) `uscampgrounds` (generic extractor
works), 3) `thedyrt` (generic works; rich RV attributes), 4) `osm_camp` (small custom
extractor to emit `node/123` ids so strong-ID matching works).

Festivals: 1) `resident_advisor` (needs unwrap; strongest dates), 2) `musicfestivalwizard`
(generic works today — verified by dry-run), 3) `viberate` / `ticketmaster` (have
coordinates), 4) `musicbrainz` (largest; strict `isPoi` filtering needed).

**Decision needed before festival ingestion — city-precision publish policy.**
`rebuildCanonicalPoi` hides any canonical whose elected coordinates are `city`/`region`
precision. Festivals are geocoded locality-only (event names mislead geocoders), so most
festivals without venue coordinates will geocode to city precision and be hidden.
Options:

1. Allow `city` precision to publish for temporal categories only (a festival "in
   Melbourne" at the city centroid is genuinely useful) — recommended.
2. Keep the rule and accept that festivals require venue-level coordinates (Viberate/
   Ticketmaster coords + RA venue geocoding may cover enough).

Whichever is chosen, record it in `docs/poi-ingestion.md`.

Acceptance:

- Each extractor emits stable `source_record_id`s; re-running extract is idempotent.
- RV/campground attributes land in `attributes`; rows with source coordinates skip
  geocoding; campsite-level records are never ingested as separate map POIs.
- Event rows populate `starts_at`/`ends_at`/`date_precision`; listing URLs stay in
  `source_url`, never promoted to `website`; recurring editions collapse into one
  canonical with `canonical_poi_occurrences` rows per edition.

---

## 8. Workstream F — End-to-End Validation

Unchanged. Create a repeatable validation record for gardens + campgrounds + festivals:

1. Run a small representative source set per category (via `ingest:run` once it exists).
2. Capture `ingest:report` output before/after.
3. SQL checks: duplicates collapsed, popularity = distinct source count, categories and
   field provenance populated, not-ready rows understood, event rows dated.
4. Re-run identical commands; confirm counts unchanged (idempotency).
5. Inspect dense map regions and detail drawers in the app.
6. Save findings in `docs/poi-ingestion-validation.md`.

---

## 9. Workstream G — Event Date Filter UI

Unchanged. Backend accepts `from`/`to` on `/api/pois`; add a compact date-range control to
the map UI, wire it into bbox requests, keep permanent POIs visible, verify the detail
drawer still renders event status.

---

## 10. Suggested Order

1. Workstream E decision (city-precision publish policy) — small, unblocks festivals.
2. `ingest:run` orchestrator (A) — every later run benefits.
3. RIDB campground extractor + first campground run (E).
4. LLM-native normalize golden set + shadow engine (D), then cut over before the messier
   festival directories.
5. Resident Advisor + Music Festival Wizard runs (E).
6. Validation doc for gardens + first campground/festival slices (F).
7. Staged legacy importer path (C).
8. Event date filter UI (G).
9. Remaining extractors by priority (E), including carnival/art-fair backlog in
   `docs/poi/carnival/` and `docs/poi/art-fairs/`.

Reasoning:

- The publish-policy decision changes what "success" means for festival runs; decide first.
- The orchestrator plus the existing report remove most operator error for everything after.
- One campground and one festival source prove the two remaining category shapes
  (permanent-with-amenities and temporal-with-editions); later sources are repetition.
- LLM normalization pays for itself starting with the first directory-scraped source, but
  shadow evaluation and evidence validation must land before activation.
