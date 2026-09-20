# POI ingestion: operation and recovery

This is the shared reference for humans and agents. [README](../README.md#poi-ingestion)
owns human setup and full-run commands. [AGENTS.md](../AGENTS.md) owns agent execution
budgets and working rules. The [database guide](../lib/db-map/AGENTS.md) maps implementation
files. Keep pipeline facts here rather than copying them into both entry points.

## Operating model

Humans run long imports and global maintenance. Agents develop and debug **every stage**
with a fixed small selection, inspect database evidence, fix causes, and validate downstream
results before handing off the full command. Both use the same managed `ingest:run` command.
All examples run from the repository root; replace angle-bracket placeholders.

```text
file → extract → fixed record cohort → normalize → geocode → embed → match → canonical check
                                                                           ↓
                                              optional global consolidation → report → verify
```

Canonical builds happen transactionally inside matching/merging and normalization refresh;
`canonical` checks their existence. It is not a separate rebuild algorithm. Stages process
one record at a time, with all selected records finishing a stage before the next starts.
A failed required operation stops the run. Non-POIs are explicitly skipped downstream.

Three distinct questions need distinct evidence:

1. **What happened in this invocation?** Execution and attempt history, provider requests,
   timestamps, errors, and local journal.
2. **Did this selected run finish?** All requested stages completed, report and global lineage
   verification and selected-record output checks passed, and the run has `status=succeeded` with `verified_at`.
3. **Is the category complete?** Every expected source/file is accounted for, intended records
   reached acceptable outputs, exclusions are reviewed, and quality checks pass. A successful
   sample or zero match-ready rows does not answer this question.

## Durable state

| Object                            | Meaning                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `research_ingest_runs`            | Logical task: source, category, file version/hash, options, pipeline versions, current stage, stop reason, verification time.                    |
| `research_ingest_executions`      | One process invocation of a run: host, PID, options, start/finish, five-second heartbeat, outcome and error. A resume creates another execution. |
| `research_ingest_run_items`       | Fixed source-record IDs and observation IDs selected after extraction; resume never expands a sample.                                            |
| `research_ingest_attempts`        | One attempt at a stage/target: execution, input IDs, output IDs, timing, structured error. Retries append rows; old errors remain.               |
| `research_ingest_run_records`     | Extraction ordinals, identities, payload hashes and outcomes. The original file is the replayable extraction input.                              |
| `research_normalization_requests` | Provider request/response, tokens, cost and latency, linked to exact run and attempt for managed work.                                           |
| `research_pipeline_jobs`          | Older mutable normalization job state. Useful diagnostic evidence, but not the execution history or managed resume authority.                    |

Attempts are inserted as `running` before work. They finish as `succeeded`, `reused`,
`skipped`, `failed`, `blocked`, `waiting_budget`, or `paused`. When a replacement worker
owns the source lock, unfinished attempts of the resumed run become `interrupted` and retries
append new attempts. Completed record attempts are skipped on resume while their outputs remain valid; missing or changed downstream outputs are checked again, then recomputed where supported or reported as blocked. Report/verify rerun.
The JSON output from an attempt identifies its normalization, geocode, embedding, canonical,
or build artifact where applicable. Existing source coordinates need no geocode artifact.

`research_pois` holds current projections and active artifact pointers. Immutable observations,
normalizations, geocodes and embeddings preserve provenance. Active
`research_canonical_memberships` are authoritative; `canonical_poi_id` is a lookup cache.
`canonical_poi_builds` / `canonical_poi_build_inputs` show how map output was built.
`research_match_decisions`, overrides, consolidation memos and redirects preserve match history.

## Command scope and limits

File paths resolve from the repository root and must be under `docs/poi/`. Categories must
exist in the code-owned taxonomy and are explicit on new runs. Known files use the source
registry; other flat JSON/JSONL/CSV files use a derived source slug and generic extractor.
Inspect the printed source. Wrapper/nested formats need extractor configuration. See the
[capture spec](poi-research/capture-spec.md) before adding sources.

| Control                                    | Behavior                                                                                                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--limit N`                                | Positive integer; caps extraction selection and freezes at most N records for every record stage. Not a time limit; hashing/parsing can still scan a large file.                      |
| `--record ID`                              | Exact **source record ID**, not research UUID; defaults to a one-record limit. Useful for a failure late in a file.                                                                   |
| `--stop-after STAGE`                       | Pause after extract, normalize, geocode, embed, match, canonical, consolidate, or report. Verify is the final stage. Exit code 2 indicates deliberate incomplete work.                |
| `--resume UUID`                            | Same managed run/cohort; new execution. Preserves original options; clears the old stop point. Only a new stop point, dry-run, and provider budgets may be supplied.                  |
| `--from STAGE`                             | New run starting record-stage processing at that stage; extraction and scope selection still happen. Skipped prerequisites must already exist. Prefer resume for failures.            |
| `--dry-run`                                | Resolve/hash file and print effective options, without writes/provider calls. Does not parse/validate all rows or simulate the pipeline.                                              |
| `--reprocess normalize`                    | New run with a stable run-specific normalization generation; recomputes once, then resumes using that generation's cached result.                                                     |
| `--reprocess extract` / `all`              | Replay extraction; `all` also forces normalization. Other forced stage values are rejected. Downstream work follows invalidation/readiness, not a blanket reset.                      |
| `--retry-failed`                           | Freeze records currently in failed/stale normalization state. It is a new repair selection, not a substitute for resuming the failed run.                                             |
| `--shadow`                                 | Evaluate normalization without activating its output; pause after normalization. Original shadow option persists on resume.                                                           |
| `--no-llm`                                 | Deterministic normalization, matching and descriptions. Does not disable geocoder or embedding calls. Degraded output does not validate the LLM path.                                 |
| `--max-llm-requests N`, `--max-cost-usd N` | Normalization budgets per execution, checked between records. Cached/deterministic results remain usable at zero budget. Repair/fallback within a record may exceed the threshold. Not a hard monetary cap and not a budget for matching/fusion. |
| `--geocode-limit N`                        | Geocoder calls per execution (default 4500); cache hits do not consume it. No shared daily-quota enforcement.                                                                         |
| `--consolidate`                            | Explicit global canonical sweep, with audited pair adjudications and merge groups. Incompatible with limited/record runs. Requires full-run human execution.                          |

A paused/blocked/budget-limited run exits 2 (pnpm prints its nonzero-exit banner); failure
exits 1; successful verified work exits 0. An empty selection is `partial`, not success.
A run beginning with `--from` only certifies its requested suffix and the integrity checks,
not that it regenerated all upstream data. A `--no-llm` success can contain degraded output.

## Bounded stage diagnostics

```bash
# Choose the failing record directly; validate normalization with a small provider budget.
pnpm --filter @lib/db-map ingest:run <file> --category <category> --record <id> --stop-after normalize --max-llm-requests 3 --max-cost-usd 0.05

# Continue the SAME record through geocoding/embedding, then matching and verification.
pnpm --filter @lib/db-map ingest:run --resume <uuid> --stop-after embed
pnpm --filter @lib/db-map ingest:run --resume <uuid>

# A deterministic sample; embedding/geocoding can still call providers if continued.
pnpm --filter @lib/db-map ingest:run <file> --category <category> --limit 3 --no-llm --stop-after normalize

# Validate a normalizer change against an exact record without activating the result.
pnpm --filter @lib/db-map ingest:run <file> --category <category> --record <id> --reprocess normalize --shadow
```

Resuming a sample does not drain the remaining source. After validation, the human starts a
new full file run. Do not loop small batches as a disguised full background import.

## Investigating the latest attempted run

```bash
pnpm --filter @lib/db-map ingest:status
pnpm --filter @lib/db-map ingest:status --source <source> --category <category>
pnpm --filter @lib/db-map ingest:status --run <uuid> --json --limit 10
pnpm --filter @lib/db-map ingest:trace --source <source> --record <id>
pnpm --filter @lib/db-map ingest:trace --canonical <uuid>
```

`latest` orders by the latest execution start (including resuming an older run), falling back
to run creation for legacy records. Pin the returned UUID before investigating further.
The compact view shows scope, execution identity, stage outcomes, recent work, unresolved
attempts, stop reason and resume command. JSON adds exact input/output IDs, errors and source
state/artifact samples. Samples are capped at 1–20 per section, not a full history export.
Queries use a consistent read-only snapshot and timeouts.

1. Inspect the latest execution and unresolved attempt. Distinguish **started work** from
   **committed results**. A stale heartbeat (over 30 seconds) is suspicion, not proof of death.
2. Read the error, input IDs, output IDs and prior attempts for that target. Trace its raw
   observation, provider response, active artifacts, membership and canonical build.
3. Fix the earliest broken stage. A schema/evidence rejection differs from a provider outage,
   a remembered geocode miss, or an intentional budget/stop limit.
4. Resume the pinned UUID. The worker acquires its source lock before recovering unfinished
   attempts; it refuses if another managed worker owns the source. File hash, extractor and
   pipeline version changes require a new run. Replaced/deleted pinned observations or changed
   active normalization output also refuse resume rather than silently mixing data.
5. Recheck status, trace representative output, and report category coverage separately.

For full history or exact recent writes, connect using the existing `DB_MAP_URL` environment
variable (never print credentials). For example, in psql set `run_id` to the chosen UUID:

```sql
-- Most recently attempted/finished units, including prior failed retries.
SELECT id, execution_id, stage, target_key, status, started_at, finished_at,
       input, output, error
FROM research_ingest_attempts
WHERE run_id = :'run_id'::uuid
ORDER BY greatest(started_at, finished_at) DESC, id DESC
LIMIT 30;

-- Provider evidence attributable to this run, not merely the same source/time window.
SELECT q.* FROM research_normalization_requests q
WHERE q.run_id = :'run_id'::uuid
ORDER BY q.created_at DESC LIMIT 10;

-- Cohort with current output pointers: current state may be newer than the run's artifacts.
SELECT i.source_record_id, i.observation_id, rp.normalization_state,
       rp.active_normalization_id, rp.active_geocode_id, rp.active_embedding_id,
       rp.canonical_poi_id
FROM research_ingest_run_items i
LEFT JOIN research_pois rp ON rp.id=i.research_poi_id
WHERE i.run_id = :'run_id'::uuid ORDER BY i.source_ordinal;
```

`first_seen_at` means insertion and `last_seen_at` means source observation, not a general
update time. Use stage artifacts and attempt output IDs for downstream write evidence.
Source-wide sections of status/report include other runs; they do not prove run attribution.

## Pausing and crash recovery

```bash
pnpm --filter @lib/db-map ingest:pause --run <uuid>
pnpm --filter @lib/db-map ingest:run --resume <uuid>
```

The first Ctrl-C or SIGTERM requests a stop after the current unit. A remote pause is noticed
on the next five-second heartbeat. The current provider request/transaction is allowed to
finish; this is not instantaneous cancellation. A second signal exits immediately.
Provider adapters have request timeouts, but retries may extend the total wait.

Each managed invocation owns a PostgreSQL session advisory lock for its source. Heartbeats
use that connection; losing it terminates the worker. The matcher also holds its existing
global match lock during match/consolidation work. Locks protect managed workers; avoid
concurrent standalone mutations or cleanup, which do not share the managed source lock.

On an abrupt kill, the database may still say running. After acquiring the source lock,
a resumed worker marks abandoned execution/attempt rows interrupted, records that the exact
termination cause is unknown, and retries unfinished work. It does not invent an OOM, timeout,
or user-cancellation explanation. Historical legacy runs are not retroactively rewritten.

The printed `lib/db-map/.ingest-logs/<run>-<execution>.jsonl` journal preserves process-local
starts, outcomes, errors and signals when database writes fail. It is ignored by git and
best-effort: retain it with terminal output when investigating an outage. Database history is
the shared authority; a local result entry alone does not prove its audit update committed.

Recovery is **at least once**. Stage transactions and artifact caches make replay safe, but
process death between a provider response/data commit and saving the attempt outcome may
repeat a provider call. Do not promise exactly-once billing. Successful artifacts are reused;
failed attempts stay visible. Run/execution start and final states are updated transactionally, as is freezing the record cohort.

Legacy runs lack execution/attempt history. Status labels their weaker evidence explicitly;
mutable jobs and source-wide timestamps can suggest the stopping point but cannot reconstruct
missing history. `--resume <legacy-uuid>` creates a new managed run linked via
`resumed_from_run_id`, reusing valid data under the original file/options. It does not invent
legacy attempt records.

## Stage behavior and invalidation

- **Extract:** stable `(source_id, source_record_id)` identities; immutable raw observations.
  Each record commits separately and is replayable. Missing IDs/collisions/write failures stop
  advancement. Snapshot removals retire only after an unlimited successful extraction, never
  a sample or interrupted pass. File completion is recorded after retirement/finalization.
- **Normalize:** deterministic facts plus evidence-validated model interpretation. Source/URL
  coordinates are authoritative; models cannot invent coordinates, contacts, or identifiers.
  Cache inputs come from immutable captured evidence, never derived projections. Keys include model, prompt/schema/examples/profile/normalizer versions.
  Failed refresh keeps prior valid output and marks it stale. Accepted changes clear derived
  embeddings/geocode pointers, invalidate old geocoded coordinates, and refresh or retire
  memberships/builds according to match changes. Prompt output must retain the input UUID.
- **Geocode:** only records missing latitude or longitude need lookup. Queries and misses are
  cached. Missing locality or a remembered miss is `blocked`; rerunning cannot fix bad input.
- **Embed:** normalized POIs need a stored embedding in the managed pipeline. Current managed
  execution uses one-record requests for precise checkpointing. Standalone embedding supports
  batches, but does not provide the managed execution ledger.
- **Match/build:** source coordinates, normalized name/category and embedding stage completion
  feed matching. Decisions, memberships and canonical rebuilds commit together. Managed LLM
  adjudication/fusion errors propagate as failures instead of silently falling back to success.
- **Consolidate:** optional global sweep; pair requests and group merges have nested attempts.
  Existing verdict memos and committed groups support resuming. Reaching the ten-pass bound fails explicitly; resume continues from committed merges and checks convergence. It can be expensive even when
  row matching is limited, so limited managed runs cannot request it.
- **Report/verify:** report failure captures the child output tail. Lineage checks cover
  membership caches, visible canonical membership, build-input counts, dangling artifacts,
  and redirect targets. Success is recorded only afterward. These are structural checks,
  not proof of geographic or editorial quality; they are global and may expose unrelated faults.

Standalone `ingest:extract`, `normalize`, `geocode`, `embed`, and `match` remain compatibility
and maintenance tools. They have their own flags and weaker audit semantics. Prefer managed
runs for new work and record-specific repairs; inspect each parser before using standalone
commands. Their dry-run/provider behavior is not the same as managed `ingest:run --dry-run`.

## File inventory and dashboard

Run `pnpm --filter @lib/db-map ingest:inventory --refresh` after adding or changing captures,
then `pnpm dev:ingestion` to open the local operations app on port 5001. The same assessment
is available as `ingest:inventory --json` or `--file <path> --json` for agent diagnostics.
See the [dashboard guide](../apps/ingestion/README.md) for setup and exact completion rules.

Inventory scans discover untouched files independently of ingestion, hash content, retain old
hashes and missing paths, and preserve operator notes, explicit category, disposition and priority.
They do not call providers or start ingestion. Resolve `needs_review` files before treating them
as an expected import set; alternate exports and supporting JSON are not automatically imports.

The dashboard derives current progress from extraction records, active artifacts, memberships,
build inputs and successful verification scopes. Retries are deduplicated by source record ID.
A completed sample cannot certify a full file. Complete extraction plus ready outputs without
current verification becomes `ready_to_verify`; its command uses `--from report` to check the
whole file. A changed hash/extractor/category requires a new run. Coverage is independent of the
latest execution's outcome and of whether the source file is still present locally.

The inventory tables are `research_ingest_inventory`, `research_ingest_inventory_versions`,
and `research_ingest_inventory_edits`. Current progress is computed, never hand-edited. File
hash state reflects the last scan of this checkout; database progress refreshes independently.
Full histories remain in PostgreSQL; dashboard drill-downs show bounded recent samples.

## Assessing category completeness

```bash
pnpm --filter @lib/db-map ingest:report --category <category>
pnpm --filter @lib/db-map ingest:report --source <source> --category <category>
pnpm --filter @lib/db-map ingest:verify
```

Compare expected files under `docs/poi/` and source research notes with
`research_source_files` / `research_source_file_versions`. Unimported files have no database
rows; a database-only report cannot prove inventory completeness. Distinguish partial
extraction, intended exclusions, failed/stale normalization, blocked coordinates/embeddings,
match-ready unlinked records, and linked published/hidden output. Counts alone do not prove
artifact freshness or quality. Report includes source-scoped sections and global canonical/cache
sections; read the labels before attributing counts to the selected file/run.

Handoff should state source/file coverage, selected vs remaining records, failure/block reasons,
linked/pending counts, degraded or excluded output, verification results, and the exact next
command. A successful sample must be described as a sample.

## Troubleshooting and optimization

| Evidence                                | Action                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction collision or wrong count     | Check parser, wrapper shape, source identity, ordinal and file hash; fix before normalization.                                                                 |
| Normalization validation/provider error | Inspect linked request, exact UUID, response, validation warnings and profile; reproduce the exact record.                                                     |
| Blocked geocode                         | Check normalized locality, source evidence, cache query/miss and quota. Correct evidence/query or deliberately invalidate the specific cache result.           |
| Failed embed/match/build                | Inspect attempt error and artifact pointers; repair the provider/configuration or responsible algorithm, then resume.                                          |
| Wrong canonical/merge                   | Trace members, decisions, overrides, coordinate election and build inputs; validate known same/different pairs.                                                |
| Old run refuses resume                  | Its pinned input/output or pipeline version changed; start a new run with an explicit repair selection and review cached artifacts.                            |
| Slow run                                | Compare attempt duration, provider latency/tokens/cost, query plans and cache hits on the same sample. Distinguish warm-cache speedups from code improvements. |

Current tradeoffs: managed processing is sequential; record-level checkpoint queries and
single-record embeddings favor debuggability over maximum throughput. Normalization cost
accounting is richer than matching/fusion accounting. Budgets are stage-specific thresholds,
not a universal quota service. File discovery is available through the inventory scanner; there is no scheduler or guarantee
that standalone scripts participate in managed locking. Add batching/concurrency only with
failure injection and unchanged provenance/recovery guarantees.

Validation commands:

```bash
pnpm --filter @lib/db-map check-types
pnpm --filter @lib/db-map ingest:normalize:golden
pnpm --filter @lib/db-map ingest:test-recovery
```

The recovery integration test requires `DB_MAP_URL`, creates an isolated temporary source,
and cleans up its rows. It exercises a fixed cohort, resume without repeated completed work,
real SIGKILL recovery, periodic heartbeat, graceful SIGTERM, source-lock exclusion, retained
failure history, remote pause, latest-execution selection, changed-file refusal, stable cache
inputs, missing-output recovery, and success only after verification. It uses non-POI fixtures and no paid providers. Live provider and output
quality checks remain separate, bounded validation.

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
