# POI Ingestion and Conflation

This is the shared reference for developing, operating, and debugging the implemented pipeline.
The [root README](../README.md#poi-ingestion) is the human full-run entry point;
[root AGENTS.md](../AGENTS.md) defines agent responsibilities and execution budgets.
Keep pipeline facts here so humans and agents use the same reference.

- [Command scope and limits](#command-scope-and-limits)
- [Bounded stage diagnostics](#bounded-stage-diagnostics)
- [Assessing category completeness](#assessing-category-completeness)
- [Stage details](#stage-details)
- [Troubleshooting and optimization](#troubleshooting-and-optimization)
- [Targeted cleanup](#targeted-cleanup)

## Model

The database has two POI layers:

- `research_*`: raw and normalized source records. These rows are internal and kept for
  provenance, re-ingestion, debugging, and match audit history.
- `canonical_*`: merged, user-facing POIs served by the map app.

The important tables are:

| Table                                                                           | Purpose                                                                                                               |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `research_sources`                                                              | Source registry, trust, licensing/attribution metadata.                                                               |
| `research_pois`                                                                 | One row per source record, with active artifact pointers, normalization state, retirement, and derived lookup fields. |
| `research_geocode_cache`                                                        | Forward-geocode cache and remembered misses.                                                                          |
| `research_match_decisions`                                                      | Audit trail for match decisions.                                                                                      |
| `research_match_overrides`                                                      | Manual force-same / force-different corrections.                                                                      |
| `research_consolidation_decisions`                                              | Memoized anchor-vs-anchor LLM verdicts reused across consolidation runs.                                              |
| `research_source_files`, `research_source_file_versions`                        | Observed file registrations, hashes, and extraction status; not an inventory of files never imported.                 |
| `research_ingest_runs`, `research_ingest_run_records`                           | Run scope, stage, counters, errors, and per-record extraction outcomes.                                               |
| `research_poi_observations`, `research_poi_normalizations`                      | Immutable captured input and validated normalization artifacts.                                                       |
| `research_normalization_requests`, `research_pipeline_jobs`                     | Request outcomes, tokens/cost, job attempts and errors. Check which stages actually populate jobs.                    |
| `research_poi_geocodes`, `research_poi_embeddings`                              | Derived artifact history tied to normalization inputs.                                                                |
| `research_canonical_memberships`                                                | Authoritative active membership and historical assignments; `research_pois.canonical_poi_id` is a lookup cache.       |
| `canonical_poi_builds`, `canonical_poi_build_inputs`, `canonical_poi_redirects` | Published build provenance and redirects after merges.                                                                |
| `canonical_pois`                                                                | One user-facing merged POI.                                                                                           |
| `canonical_categories`                                                          | Code-owned taxonomy.                                                                                                  |
| `canonical_poi_categories`                                                      | Many-to-many POI/category links.                                                                                      |
| `canonical_poi_occurrences`                                                     | Event editions for recurring temporal POIs.                                                                           |
| `geo_centroids`                                                                 | Local centroid references used by normalization and coordinate checks.                                                |

The schema intentionally avoids PostGIS and pgvector. Coordinates are plain `lng`/`lat`
doubles, embeddings are stored as `real[]`, and fuzzy name matching uses `pg_trgm`.

## Operating principles

- Develop and debug all stages with small samples; run full workloads manually as a human.
- Identify the category, source, file version, and record IDs before changing data.
- Preserve source evidence, stable IDs, prior valid artifacts, and resumable progress.
- Use deterministic signals first, then evidence-validated LLM interpretation where needed.
- Diagnose the earliest failed stage and validate its downstream effects.
- Use the code-owned taxonomy. Category is required by `ingest:run` and `ingest:extract`.
- Use `--recluster` only with explicit user authorization to start over.

## Command scope and limits

Commands below run from the repo root; replace angle-bracket placeholders before execution.
File arguments resolve against the repository root and must be under `docs/poi/` (including
for the compatibility `ingest:extract` entry point). The source registry resolves known
files; unregistered flat JSON/JSONL/CSV files use an inferred source slug and generic extractor.
Check the printed source before continuing. Nested/wrapper formats need registry configuration.

The file-first command records a file hash/run and dispatches:

```text
extract → normalize → geocode → embed → match + global consolidation → report + lineage verification
                                          └─ canonical builds occur during matching/merging
```

Its stage names are `extract`, `normalize`, `geocode`, `embed`, `match`, `canonical`, and
`report`. There is currently no separate canonical rebuild pass: `--from canonical` skips
matching and reaches reporting/verification. To diagnose a build, trace the canonical and
exercise the responsible match/merge path on a controlled sample.

These are current implementation limits, not promises about future behavior:

| Control                                                          | Actual scope and consequence                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingest:run --dry-run`                                           | Resolves and hashes the file, then exits without database writes or provider calls. Does **not** parse/validate every record or simulate downstream stages; hashing a large file can take time.                                                    |
| `ingest:run --limit N`                                           | Caps extraction and passes a limit to individual row stages. Later stages select by **source**, not file/category/selected record IDs. They can process different records than extraction.                                                         |
| `--stop-after embed` (or an earlier stage)                       | Stops before matching and global consolidation. Combine with a small limit for agent diagnostics. `--stop-after match` stops only after consolidation has run.                                                                                     |
| `ingest:normalize --limit N`                                     | Fetches source rows first, then limits processed rows; cached rows count toward N. Repeating a small limit may keep visiting the same prefix. This is not a pagination/resume cursor or a database scan bound.                                     |
| `ingest:geocode --limit N --geocode-limit M`                     | N bounds selected rows; M bounds new API calls in this invocation. Cache hits/misses still require work; M is not a persistent daily quota.                                                                                                        |
| `ingest:embed --limit N --batch-size M`                          | N caps rows; M controls request batch size only. A small batch size alone does not make a short run.                                                                                                                                               |
| `ingest:match --source <source> --limit N`                       | Caps pending research rows for that source. Canonical candidates and builds can include other sources. No category filter.                                                                                                                         |
| `--consolidate` / `--consolidate-only`                           | Global canonical sweep, unaffected by source or row limit. Consolidate-only rejects `--source` and `--limit`. A dry run can still scan broadly and call the LLM. Human full-run operation.                                                         |
| `ingest:run --max-llm-requests N` / normalize `--max-requests N` | Normalization budget, not a cap on the full pipeline's provider calls. Repairs/retries can add requests.                                                                                                                                           |
| `--max-cost-usd N`                                               | Normalization checks accumulated estimated cost between records; an in-flight request can exceed it. Does not cap geocoding, embedding, matching, or consolidation.                                                                                |
| `--no-llm`                                                       | Deterministic/degraded normalization or matching. Does not disable geocoding or embedding providers. Match dry runs need this flag to avoid LLM adjudication.                                                                                      |
| `--shadow`                                                       | Writes normalization evaluation artifacts without activating them. Can call the provider. File-first runs stop after normalization, but extraction can already have written data; use `--from normalize --shadow` for existing observations.       |
| `--from <stage>`                                                 | Skips earlier dispatch stages; does not isolate a single stage. `--from normalize` also forces normalization. Pair with `--stop-after` and a limit for bounded evaluation.                                                                         |
| `--reprocess <stage>`                                            | File-first code forces extraction or normalization for those stages (or `all`). It does not currently force new geocodes, embeddings, matches, or canonical builds. Inspect selectors/cache invalidation before promising downstream reprocessing. |
| `--retry-failed`                                                 | Accepted and passed to normalization, but the current runner does not use it to filter/retry only failed rows. Normal runs revisit source rows and reuse successful caches.                                                                        |

Do not assume every CLI supports every flag: for example, standalone normalize has no
`--dry-run`, and most standalone stages have no `--category`. Inspect its parser when in doubt.
If the required scope is unavailable, use record fixtures/read-only evidence and implement a
proper diagnostic control as part of the relevant fix. Do not silently broaden execution.

## Bounded stage diagnostics

Start with a read-only baseline, then choose the affected stage. Live runs below can write
to the database; the limits reduce work, not necessarily all query/scan time. Use 1–5 records
initially when providers are involved. Source-wide selectors may include multiple categories.

```bash
pnpm --filter @lib/db-map ingest:report --category <category>
pnpm --filter @lib/db-map ingest:report --source <source> --category <category>
pnpm --filter @lib/db-map ingest:trace --source <source> --record <source-record-id>
pnpm --filter @lib/db-map ingest:trace --canonical <uuid>
```

| Stage                                                 | Small diagnostic command (prefix each with `pnpm --filter @lib/db-map`)                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Resolve file and source                               | `ingest:run <file> --category <category> --dry-run`                                                                    |
| Observe/extract                                       | `ingest:run <file> --category <category> --limit 5 --stop-after extract`                                               |
| Normalize existing rows, deterministic evaluation     | `ingest:normalize --source <source> --limit 5 --no-llm --shadow`                                                       |
| Normalize existing rows, real provider and activation | `ingest:normalize --source <source> --limit 3 --max-requests 3 --max-cost-usd 0.10`                                    |
| Evaluate a normalizer change without activation       | `ingest:run <file> --category <category> --from normalize --shadow --limit 3 --max-llm-requests 3 --max-cost-usd 0.10` |
| Geocode preview                                       | `ingest:geocode --source <source> --limit 5 --geocode-limit 3 --dry-run`                                               |
| Geocode live                                          | `ingest:geocode --source <source> --limit 5 --geocode-limit 3`                                                         |
| Embed preview                                         | `ingest:embed --source <source> --limit 5 --dry-run`                                                                   |
| Embed live                                            | `ingest:embed --source <source> --limit 5 --batch-size 5`                                                              |
| Match startup counts, no row processing               | `ingest:match --source <source> --limit 0 --dry-run --no-llm`                                                          |
| Match deterministic preview                           | `ingest:match --source <source> --limit 5 --dry-run --no-llm`                                                          |
| Match and build live, deterministic                   | `ingest:match --source <source> --limit 3 --no-llm`                                                                    |
| Match and build live, provider path                   | `ingest:match --source <source> --limit 1`                                                                             |

For a short pass across the earlier stages, use
`ingest:run <file> --category <category> --limit 3 --stop-after embed --max-llm-requests 3 --max-cost-usd 0.10 --geocode-limit 3`
with the same pnpm prefix. Then use bounded standalone matching, followed by reports and
traces. Confirm the same target records actually reached each stage; selectors are independent.
Global consolidation needs fixtures or a scoped implementation test for quick agent validation.

Existing checks (choose those relevant to the change):

```bash
# Local deterministic normalization checks; no live provider required.
pnpm --filter @lib/db-map ingest:normalize:golden
# Reads one record from each configured garden source fixture.
pnpm --filter @lib/db-map ingest:test-extractors
# Uses database records; missing golden fixtures affect coverage.
pnpm --filter @lib/db-map ingest:match:golden --no-llm
# Read-only, database-wide lineage checks; no source/limit filter.
pnpm --filter @lib/db-map ingest:verify
pnpm --filter @lib/db-map check-types
```

A deterministic check does not validate live model quality. Verification checks structural
lineage, not category completeness or the correctness of every merge. Report coverage and
limitations explicitly; read-only aggregate checks may still take time on a large database.

## Assessing category completeness

1. **Inventory expected inputs.** Read `taxonomy.ts`, `sources.ts`, and the category's files
   and source notes under `docs/poi/`. Identify each intended source/file and exclusions.
   Compare them with `research_source_files` and the latest file versions. An unimported
   source is absent from reports, not complete. If the expected inventory is unknown, say so.
2. **Run a category report**, then source/category reports for bottlenecks. Record the time,
   file versions, and run IDs. Run reports before and after bounded validation.
3. **Reconcile extraction.** Check complete/partial/failed file versions, run counters,
   identity collisions, rejected records, retirement, and changed files. Raw item counts can
   differ from distinct source IDs; explain duplicates instead of expecting equality.
4. **Reconcile each stage.** Separate pending/stale normalization from accepted, degraded,
   valid non-POI rejection, and technical failures. Explain missing coordinates, cached
   geocoder misses, missing embeddings, ready-to-match rows, and linked rows.
5. **Check publication.** Trace representative linked rows to active memberships/build inputs,
   published/hidden canonicals, redirects, category links, and event occurrences as applicable.
   Inspect the map/API when debugging display behavior. Consolidation quality needs evidence
   beyond “all rows linked.” Run lineage verification for membership/build changes.
6. **State what remains.** A category is complete only relative to its declared input inventory
   and quality requirements: all intended inputs processed, exclusions explained, no
   unexplained failures/stale/blocked records, matchable rows linked, and expected canonicals
   published and validated. Missing embeddings need an explicit disposition because matching
   does not require them. Report unresolved geocodes or deferred consolidation as remaining work.

Report interpretation matters:

- `pending` means **ready to match**, not all unfinished ingestion work.
- Stage counts are overlapping field-presence counts, not disjoint buckets or freshness checks.
  An old active value can remain while a refresh fails; inspect state, hashes, and artifacts.
- Readiness assigns unlinked POIs to missing coordinates first, then name, then categories;
  later missing-field counts do not enumerate every row missing that field.
- Research-side category filtering uses ingest category **or** normalized category membership.
  Counts currently include retired rows; use scoped SQL when an active-only denominator matters.
- Canonical sections are category-scoped but not source-scoped; geocode-cache totals are global.
  Provider totals in the report cover normalization requests, not every pipeline provider.
- Only five recent runs are shown. A `succeeded` run is not an exhaustive coverage certificate.
  Standalone stage runs also do not provide all the same orchestrator run counters.

Use this compact handoff shape for an assessment; include separate rows for each source/file
when needed, and say “unknown” rather than inventing missing counts:

| Category/source/file  | Extraction coverage                       | Normalization state                       | Coordinates/embeddings       | Linked / ready / blocked | Publication and remaining work  |
| --------------------- | ----------------------------------------- | ----------------------------------------- | ---------------------------- | ------------------------ | ------------------------------- |
| `<scope and version>` | `<observed vs expected; partial/missing>` | `<active/degraded/rejected/failed/stale>` | `<present/missing; reasons>` | `<counts with scope>`    | `<published/hidden; next step>` |

If reporting lacks the necessary evidence, inspect the schema and query it directly.
For example, open `psql "$DB_MAP_URL" -v category=campground` and run these read-only queries
(replace the category in the invocation):

```sql
-- Observed file versions only: compare with the source-file inventory on disk.
SELECT rs.slug, f.logical_path, v.file_sha256, v.status, v.record_count,
       v.error, v.created_at, v.completed_at
FROM research_source_files f
JOIN research_sources rs ON rs.id = f.source_id
JOIN research_source_file_versions v ON v.source_file_id = f.id
WHERE f.category_slug = :'category'
ORDER BY f.logical_path, v.created_at DESC;

-- More detail than the report's five recent runs.
SELECT id, source_file_version_id, status, current_stage, counters,
       fatal_error, resume_command, heartbeat_at, created_at
FROM research_ingest_runs
WHERE category_slug = :'category'
ORDER BY created_at DESC
LIMIT 20;
```

Inspect `research_ingest_run_records.last_error`, `research_normalization_requests.error`,
and `research_pipeline_jobs.error/error_details` for the relevant run/record IDs. An extraction
failure may have no `research_pois` row and thus no trace: use its run record/source ordinal.
A stale `running` status alone does not prove a process is alive; correlate with terminal
output, heartbeat, active processes, and database locks before resuming overlapping work.

## Stage Details

The commands in this section illustrate full manual operations. For agent execution, use
the [bounded recipes](#bounded-stage-diagnostics) above.

### Taxonomy

`ingest:taxonomy:seed` syncs code-owned categories into `canonical_categories`.

Source imports must specify one canonical category with `--category <slug>`. Unknown slugs
are hard errors; add new categories in code first, then seed them.

### Extract

The orchestrated observation pass streams the source file and upserts stable identities by
`(source_id, source_record_id)`. Each distinct redacted raw payload becomes an immutable
`research_poi_observations` row. `research_pois` points to its active observation.

Record-level writes are logged in `research_ingest_run_records` before the research write.
If one record fails, successful records remain committed and a rerun retries only the
missing/failed row. If PostgreSQL is unavailable, the run stops; the immutable source file
remains the replayable queue.

During extract, the CLI prints one line per record when it finishes:

```text
extract ok #42 inserted thedyrt:12345 "Sunset RV Park"
extract failed #43 thedyrt:99999 (connection terminated)
```

A long pause before the first line usually means the run is still hashing the file or
writing the first database row — not a silent crash. Later stages log similarly
(`normalize ok …`, `normalize failed …`).

`ingest:extract` remains as a lower-level compatibility command.

```bash
pnpm --filter @lib/db-map ingest:extract bgci docs/poi/botanical_gardens_data/bgci_gardens_full.json --category botanical_garden
```

Re-importing unchanged records updates observation metadata without resetting downstream
work. Changed records create a new observation and mark normalization stale while the prior
active normalization remains available until its replacement validates.

Sources registered in `scripts/ingest/sources.ts` without a custom extractor fall back to
the **generic capture-spec extractor**: files whose records follow
`docs/poi-research/capture-spec.md` (flat objects in a top-level JSON array, JSONL, or CSV
with the standard field names) need only a source metadata entry and zero extractor code.
Write a custom extractor only when the file shape does not conform (wrapper objects,
HTML-laden fields or nested venue objects). The file-first resolver currently accepts only
JSON, JSONL, and CSV; other formats need conversion or resolver support as well as parsing.

### Normalize

`ingest:normalize` is a hybrid deterministic + DeepSeek stage:

1. Deterministic code validates structured dates, coordinates, URLs, contacts, country
   codes, source flags, and taxonomy constraints.
2. DeepSeek receives exactly one real record plus two reviewed example conversations.
3. The model classifies validity and interprets identity, edition, locality, URL roles,
   description, and typed attributes.
4. Deterministic resolvers reject invalid dates, unsupported facts, listing URLs promoted
   as official, and any model-invented contacts/identifiers.
5. DeepSeek never returns coordinates; coordinates come only from source data, URL parsing,
   or geocoding.
6. Accepted output is stored as an immutable `research_poi_normalizations` artifact and
   activated transactionally.

```bash
pnpm --filter @lib/db-map ingest:normalize --source bgci
```

Use `--no-llm` for a deterministic degraded projection. Default execution is sequential,
one record per LLM request, with additional calls possible for fallback/repair. Results are
cached by observation, prompt, schema, examples, profile, model, and normalizer versions;
matching successful cache entries avoid new normalization requests. A deterministic-only
projection has its own cache key and does not replace an existing active normalization.

### Geocode

`ingest:geocode` only selects POI rows where `lat IS NULL`. Rows that already carry source
coordinates do not spend geocoder budget.

```bash
pnpm --filter @lib/db-map ingest:geocode --source bgci --geocode-limit 4500
```

Geocode results and misses are cached by normalized query in `research_geocode_cache`. When
the per-run call budget is hit, remaining rows still have `lat IS NULL`. Check the provider
quota before resuming; repeated invocations do not enforce a shared daily budget.

### Embed

`ingest:embed` selects normalized POI rows missing `content_embedding`.

```bash
pnpm --filter @lib/db-map ingest:embed --source bgci --batch-size 32
```

Embeddings are a scoring signal, not a hard prerequisite for matching.

### Match

`ingest:match` links matchable `research_pois` rows into `canonical_pois`.

Matchable rows have:

- `canonical_poi_id IS NULL`
- `is_poi = true`
- coordinates
- `name_normalized`
- `category_slugs`

Normal matching is resumable:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate
```

Progress is the `research_pois.canonical_poi_id` value. Completed rows are skipped on the
next run. The script prints linked/pending counts, not-ready counts, existing decision
counts, and a suggested resume command at startup.

For smaller work chunks:

```bash
pnpm --filter @lib/db-map ingest:match --limit 500
```

First `Ctrl-C` stops after the current row or consolidation group and prints a resume
command. A second `Ctrl-C` exits immediately.

Additional matcher controls:

| Option                                    | Effect                                                                                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `--gc-orphans`                            | Hides canonicals without linked research rows after row work; global maintenance, not bounded by the row limit.                |
| `--auto-threshold N`, `--low-threshold N` | Override automatic-merge and new-POI score thresholds; validate labeled pairs before changing them.                            |
| `--no-llm`                                | Skips match adjudication and description fusion; ambiguous pairs may become new POIs.                                          |
| `--recluster`                             | Resets clusters globally; incompatible with `--source`, `--limit`, and `--dry-run`. See the explicit authorization rule below. |

## Match and Merge Rules

The matcher uses a cascade:

1. Manual overrides from `research_match_overrides`.
2. Strong IDs, such as Wikidata QIDs and OSM identifiers.
3. Aggressive proximity rules for same-category nearby features.
4. Candidate scoring from name, stored embedding similarity, distance, locality, contact
   fields, coordinate precision, and date compatibility.
5. LLM adjudication for ambiguous gray-zone pairs when LLM is enabled.

Each non-dry-run decision writes `research_match_decisions`.

When a row links to a canonical, `rebuildCanonicalPoi` recomputes the published canonical
from all linked research rows. This prevents description text from being appended repeatedly across reruns. When LLMs are
enabled, ambiguous matching and canonical description fusion can make provider calls;
matching itself does not geocode records or create embeddings.

## Aggressive Conflation

The implemented product stance is to prefer over-grouping for close same-category features,
especially botanical gardens and similar grounds where source data often maps sub-features
as separate POIs.

Important concepts:

- **Anchor**: a stronger canonical, such as one with multiple sources, high source trust, or
  an official website.
- **Satellite**: a weaker nearby feature, often one source and no website.
- **Satellite + anchor**: same-category satellites inside the proximity box merge into the
  anchor.
- **Satellite + satellite**: nearby satellite groups consolidate around a deterministic
  leader/medoid.
- **Anchor + anchor**: proximity alone is not enough; LLM decides when enabled.
- **Same-name block**: distinctive exact-name matches can merge even when coordinates differ
  enough that ordinary spatial blocking would miss them.

Coordinate election prefers corroborated point coordinates over a single high-trust outlier.
Canonical descriptions are rebuilt from source rows and may include contained feature
sections plus `attributes.contained_features`.

## Consolidation

Row matching is order-dependent: a satellite may be ingested before its anchor, or an earlier
run may have been executed with `--no-llm`. Consolidation is the canonical-vs-canonical
cleanup sweep that heals those cases.

Run it after matching:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate
```

Run only consolidation without processing pending research rows:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate-only
pnpm --filter @lib/db-map ingest:match --consolidate-only --dry-run
```

Anchor-vs-anchor pairs are the only consolidation decisions that need the LLM, and those
verdicts are memoized in `research_consolidation_decisions`. A rerun skips previously
adjudicated pairs; a stored verdict is re-asked only when either canonical has been
rebuilt with new data since the verdict (`canonical_pois.updated_at` newer than the memo).
Memoization reduces repeated adjudication calls; it does not bound the global sweep's
runtime. Satellite merge decisions are deterministic, while canonical rebuilds may still
invoke description fusion when LLMs are enabled.

## Re-importing a Source (Idempotency)

Normal reruns reuse extraction and normalization work where input/version keys match:

- File bytes are tracked in `research_source_file_versions`.
- Rows are keyed by `(source_id, source_record_id)` and raw observation hash.
- **Unchanged files** skip completed extraction; normalization reuses matching cached artifacts.
  Later stages select by their own readiness fields, and consolidation still performs a sweep.
- **Changed records** append observations and trigger normalization; downstream work depends
  on activation/invalidation and each stage selector. Trace the affected artifacts to verify it.
- Normalization activation preserves prior output when a replacement fails; validate active
  pointers and downstream build inputs when diagnosing a failed refresh.
- **New records** flow through the pipeline normally.
- For registered `snapshot` files, removed records retire only after a complete successful
  extraction pass; limited/interrupted runs never infer deletion.

Normalization hashes include model, prompt, schema, examples, profile, and implementation
versions. Do not assume changing any version constant automatically reruns every affected
stage. See [command scope and limits](#command-scope-and-limits) for the implemented behavior
of `--reprocess`, `--from`, `--shadow`, and retry flags. None implies a full recluster.

The prerequisite remains a stable `source_record_id` per record — see
`docs/poi-research/capture-spec.md`.

## Full Recluster

`--recluster` is destructive. It deletes match decisions, nulls every linked
`research_pois.canonical_poi_id`, deletes canonicals, and rebuilds from raw research rows.

The human runs this only when intentionally starting over; agents require explicit user
authorization for destructive reclustering:

```bash
pnpm --filter @lib/db-map ingest:match --recluster --consolidate
```

Do not use `--recluster` to resume a stopped run.

## Event POIs

Permanent POIs have no dates. Temporal categories, such as music festivals, use typed date
columns:

- `starts_at`
- `ends_at`
- `date_precision`
- generated `event_range`
- `canonical_poi_occurrences` for recurring editions

The canonical row stores the representative occurrence: next upcoming when available,
otherwise the most recent. Status such as upcoming, ongoing, or past is derived at read time.

## Reflow and Backfills

After changing pipeline logic, verify the affected stage's cache key and invalidation path,
then use the bounded diagnostics above. Normalization supports forced reprocessing and shadow
evaluation; downstream `--reprocess` values currently do not force recomputation. Prepare the
full manual rerun only after proving that the changed sample actually recomputes.

`ingest:reflow` remains a legacy maintenance command for pre-orchestration rows; it resets
derived columns and is not the normal reprocessing path.

Other maintenance entry points (use the `pnpm --filter @lib/db-map` prefix):

- `ingest:seed:centroids` loads local centroid references.
- `ingest:backfill:wikidata-coords` fills coordinates from Wikidata attributes where available
  without spending geocoder budget.
- `ingest:override` manages manual force-same / force-different match corrections.

Inspect each parser and intended scope before running it. A maintenance command is not a
short diagnostic merely because it avoids a provider. Human full runs follow bounded validation.

## Reporting

`ingest:report` prints a read-only reconciliation summary: research rows by source and
stage, match readiness (pending vs missing coords/name/categories), canonicals by primary
category with published/hidden splits, match decisions by method, geocode cache
effectiveness, popularity distribution, top contributing sources, event date coverage,
hybrid normalization/request totals, cost/tokens, and recent file ingest runs.

```bash
pnpm --filter @lib/db-map ingest:report
pnpm --filter @lib/db-map ingest:report --source bgci
pnpm --filter @lib/db-map ingest:report --category music_festival
```

Run it before and after every source import; the output is compact enough to paste into a
PR or validation log.

## Troubleshooting and optimization

Work from the earliest incorrect artifact forward. Use traces for provenance and targeted SQL
for request/job errors absent from traces. Do not erase evidence to make a run look clean.

| Symptom                                             | Evidence and next action                                                                                                                                                                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source/category absent from report                  | Compare disk/registry inventory with observed file versions. Confirm category/source resolution, whether extraction ran, and its run-record errors.                                                                                          |
| Few extracted rows or ID collisions                 | Inspect extractor output, wrappers, stable ID generation, source ordinals, duplicate/collision counters, and full vs limited file status. Fix identity before retrying.                                                                      |
| Normalization repeatedly fails or degrades          | Inspect observation, request/response, validation warnings, job errors, profile, model, and input hash. Distinguish provider failures from evidence/schema rejection; reproduce with a small shadow run.                                     |
| Limited normalization never reaches failing records | Cache hits consume the prefix limit. Use fixtures or implement record-targeted selection; do not loop the same prefix or increase to an unbounded run.                                                                                       |
| Missing coordinates                                 | Check source/URL coordinates, normalized locality, geocode query, remembered miss, quota and call counters. A remembered miss is not fixed merely by rerunning; correct evidence/query or targeted cache handling. Never invent coordinates. |
| Missing embeddings                                  | Inspect normalized text, provider/configuration errors, selection predicate, and artifact pointer. Matching may proceed without embeddings; assess whether degraded scoring is acceptable.                                                   |
| No match progress                                   | Check readiness, not just total unlinked rows. Matching cannot repair missing coordinates/name/categories. Inspect lock ownership if another matcher is running.                                                                             |
| Wrong merge or duplicate canonicals                 | Trace both records/canonicals; inspect `research_match_decisions`, overrides, candidate blocking, scores, dates, coordinates, and consolidation memos. Validate known same/different pairs before changing thresholds.                       |
| Linked but hidden/wrong on map                      | Inspect canonical status/category/coordinates, active membership, build inputs, redirects, and app query filters. Run lineage verification and inspect a representative API/UI result.                                                       |
| Run says succeeded but work remains                 | Reconcile file inventory, limited-stage counters, normalization state, blocked rows, and publication. Exit status alone does not establish completeness.                                                                                     |
| Run is slow or costly                               | Identify time in file hashing, DB queries, provider calls/retries, rebuilds, or global consolidation. Check selected vs processed rows, cache hits, request tokens/cost, and whether the intended limit reaches the expensive stage.         |

For optimization, compare the same representative inputs and configuration before/after.
Record elapsed time, records processed, provider calls, tokens/cost when available, cache hits,
failures, and output quality. Distinguish warm-cache speedups from algorithmic improvements.
Inspect query plans before broad index/concurrency changes; remember `EXPLAIN ANALYZE` executes
the query. Preserve idempotency, lineage, and matching quality while reducing work.

Handoff after a fix: identify the cause and evidence, what changed, checks actually run,
before/after scoped counts, unresolved work, and the exact human full-run/resume command plus
verification commands. If only a sample was validated, say so. Do not declare an entire
category complete from a successful sample, or conceal a missing diagnostic capability.

## Targeted cleanup

`ingest:clean` removes selected source-record lineage. Use it when removal is part of the task,
not as routine resume or a substitute for fixing failed stages. Capture relevant traces/errors
first. It uses the same file resolver/extractor as `ingest:run`, including synthesized IDs.

```bash
# Review the exact first five parsed records and their impact.
pnpm --filter @lib/db-map ingest:clean <file> --limit 5 --dry-run
# Apply that targeted removal when needed for the task.
pnpm --filter @lib/db-map ingest:clean <file> --limit 5
```

Cleanup deletes selected research rows, observations, normalization/provider artifacts, match
history/memberships, run-record entries, and stale jobs. Orphan canonicals are deleted; shared
canonicals rebuild from remaining research rows. Review that downstream work too: a small
input limit is not a bound on all affected memberships/builds.

Colliding source IDs are grouped: cleanup removes the coalesced database lineage and every
stored observation under it, reporting coalesced input counts. Shared source-file/run metadata
and the shared geocode cache remain. Cleanup does **not** filter by category; its compatibility
`--category` argument is ignored. Do not use it expecting a category-only deletion.
