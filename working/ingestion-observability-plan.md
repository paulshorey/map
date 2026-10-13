# Ingestion visibility assessment and implementation plan

Status: assessed; implementation proposed. This change contains documentation only.
Evidence collected on October 12, 2026, approximately 20:45–20:49 America/Chicago
(October 13, approximately 01:45–01:49 UTC), against main `25eed70`.
Counts below are a dated observation, not a maintained progress ledger.

## Assessment

There is enough durable evidence to identify the current worker and enumerate the
captured-file backlog. It takes several interfaces and manual reconciliation to
reach a reliable answer. Agents need a shared, bounded operations snapshot before
this is a dependable autonomous decision surface.

Keep PostgreSQL runs, executions, attempts, inventory, artifacts, memberships and
verification as the authorities. Keep supervisor journals and coordinator intents
as process/launch evidence. Extend their shared assessment rather than maintaining
a second mutable status file or a separate browser interpretation.

The existing foundation is substantial:

- `ingest:inventory --json` discovers untouched captures and reports independent
  coverage, execution, freshness, disposition and stage-output counts.
- `ingest:queue --json` has a versioned action snapshot and suppresses launches
  while process evidence is not quiescent or maintenance is active.
- `ingest:status --run UUID --json` provides bounded attempts, errors, execution
  identity and provider evidence; `ingest:trace` follows record/artifact lineage.
- `scripts/coordinator-ingestion.py snapshot` discovers database workers/locks,
  local supervised jobs and launch intents.
- `apps/ingestion` already shares file assessment with the CLI, has file/run
  drill-downs and retains classifications/notes. Its live API answered successfully.

Operational references remain in the [runbook](../data/poi-ingestion.md),
[agent operations guide](../data/ingestion-agents.md) and
[dashboard guide](../apps/ingestion/README.md). This plan does not replace them.

## Current data and process evidence

The persisted inventory contains 247 captures: 234 JSON and 13 CSV, totaling
745,021,790 bytes. It was last scanned on October 8 at 22:46:51.700 UTC.
A fresh read-only invocation of the existing `discoverFiles()` implementation
found exactly the same paths and hashes, with no added/missing files or scan
errors. Other files in `data/poi` were notes/scripts plus one extensionless file;
no additional files with other raw-data extensions were found.

| Disposition / progress           |      Files |
| -------------------------------- | ---------: |
| Intended imports                 |        160 |
| Structurally complete imports    |          2 |
| Active partial import            |          1 |
| Legacy partial selection         |          1 |
| Unstarted intended imports       |        156 |
| Needs classification review      |         10 |
| Supporting / alternate / ignored | 64 / 7 / 6 |

The 77 supporting/alternate/ignored files should not inflate the import backlog.
The queue currently groups them under `blocked`; distinguish intentional exclusion
from actionable failure in the proposed summary. The queue reports 157 `start`
actions because the legacy partial selection also needs a new full-file run.
Admission is closed by the active worker; `next` is correctly null.

| Import category   | Intended files | Unstarted |  Partial | Complete |
| ----------------- | -------------: | --------: | -------: | -------: |
| Art fairs         |             26 |        25 | 1 legacy |        0 |
| Art parades       |             39 |        38 |        0 |        1 |
| Carnivals         |             39 |        39 |        0 |        0 |
| Music festivals   |             42 |        42 |        0 |        0 |
| Arboretums        |              1 |         1 |        0 |        0 |
| Botanical gardens |              7 |         7 |        0 |        0 |
| Hostels           |              2 |         1 |        0 |        1 |
| Campgrounds       |              4 |         3 | 1 active |        0 |

The completed files are `data/poi/hostels/california-hostels.json` (52/52
verified source records) and `data/poi/art-parades/street-arts/aurillac_festival.json`
(6/6). All 58 records have degraded normalization flags. Their structural
completion does not establish provider-path validation or editorial/geographic
quality. No category is established as complete.

The legacy partial file is `data/poi/art-fairs/craft-shows/artfairslist.json`.
Its unmanaged July selection used `limit=20` and `noLlm=true`; its current total
is unknown and it has no current ready/verified outputs. Resuming a limited
selection cannot finish the full capture.

The active The Dyrt file is
`data/poi/rv_campgrounds_data/thedyrt/rv_campgrounds.csv`:

- Run: `4dda8606-9c20-4275-bae6-c14cdea9e38c`.
- Execution: `7561fd60-9f00-4ecd-965c-55b168c53623`, started October 10 at
  17:25:33 UTC with `unlimited=true` and no overall supervisor deadline.
- Supervisor job: `f6c1a95e-7759-4c42-a8dc-a48af1e2d8df`; supervisor PID 56688,
  child PID 56689 at this observation. These PIDs are historical evidence and
  must be reidentified before any later signaling.
- Full extraction: 43,272 distinct source records. Current normalized outputs:
  16,714 (38.6%), including 50 excluded non-POIs. There are two failed/stale
  normalization states and two degraded outputs. Remaining current normalization
  work is approximately 26,558 records; live counters continue to change.
- Two current embedded records, three linked records, two published-ready
  records and two verified records. The full run has `verified_at=null`.
  Stage processing is sequential across the cohort; downstream stages remain.
- Database heartbeat was fresh, the source/admission locks were held, and recent
  successful normalization attempts were committing roughly every 20–27 seconds.
  Later journal evidence committed record `49578` at 01:48:17 UTC and started
  `49580`. This establishes real progress beyond a heartbeat.
- The latest execution reported 10,563 normalization requests and approximately
  $32.73 attributed estimated normalization cost at the status observation, with
  one unknown-cost request. Matching/fusion and other providers are outside that
  cost total. Cost is telemetry under the standing policy.
- Maintenance was off; snapshot claims were empty. No worker was stopped,
  restarted or launched for this assessment.

Other classified campground captures await ingestion: OSM `caravan_sites.csv`,
RIDB `facilities.csv`, and USCampgrounds `all_campgrounds_combined.csv`.

The ten unresolved classifications are:

1. `data/poi/rv_campgrounds_data/ridb/campsites_rv_hookup.csv`
2. `data/poi/music-festivals/other/bandsintown_festivals.json`
3. `data/poi/music-festivals/other/setlistfm_festivals.json`
4. `data/poi/music-festivals/regional/bandwagon_asia_full.json`
5. `data/poi/music-festivals/regional/getfestiwise_festivals_full.json`
6. `data/poi/music-festivals/regional/world_festival_directory.json`
7. `data/poi/music-festivals/ticketmaster_art_events.json`
8. `data/poi/music-festivals/wikipedia/wikipedia_country_music_festivals.json`
9. `data/poi/music-festivals/wikipedia/wikipedia_festival_names.json`
10. `data/poi/music-festivals/wikipedia/wikipedia_festivals.json`

## Observed gaps

| Priority | Evidence                                                                                                                                                                                                                                                     | Consequence                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| P0       | `inventory-scan.ts` requests exclusive `(91832,1)`; `ingestion-control.ts` gives live workers shared `(91832,1)`. Refresh failed with `Inventory refresh already running`; `pg_locks` showed only the worker's granted ShareLock at that key, backend 61138. | Inventory refresh is unavailable during a healthy import, and the error misidentifies the blocker.                         |
| P0       | Worker host `Pauls-MacBook-Pro` differs from current `Pauls-MacBook-Pro.attlocal.net`. Control reports `remote_unknown` while local process discovery and explicit PID/start/CWD inspection find the worker.                                                 | Local identity remains uncertain after a network hostname change. Never weaken stop/reconcile checks to hide the mismatch. |
| P0       | Queue `requires` still includes `explicit_provider_budgets`; queue/full-file resume arrays omit `--unlimited`. Active execution is uncapped, while stored original run options lack that override.                                                           | Machine recommendations conflict with current authorized policy and can silently retain old caps on a later resume.        |
| P1       | Inventory, control, queue, supervisor jobs and coordinator intents have separate shapes, clocks and entry points. Dashboard `/api/inventory` includes only the maintenance row, not reconciled worker/job/claim evidence.                                    | Agents must join state manually; GUI and agent views can disagree about active work and safe next actions.                 |
| P1       | File scan timestamp describes persisted metadata, while API inspection timestamp describes database query time. No durable scan-attempt receipt identifies the checkout/commit that was scanned.                                                             | A fresh API response can conceal old file discovery; scans from different checkouts share the inventory.                   |
| P1       | Per-stage record counts exist, but generic verified percentage stays near zero during normalization. Old preparation counters and historical attempts/provider recovery coexist with live execution evidence.                                                | Heartbeats and stale counters can conceal lack of committed progress or suggest an obsolete blocker.                       |
| P2       | Structural completion admits degraded output; expected-source coverage is not represented by a reviewed source/capture catalog.                                                                                                                              | Complete-file counts cannot establish category completeness or data quality.                                               |

## Proposed implementation sequence

### 1. Repair correctness of current evidence and recommendations

Ownership: `lib/db-map/lib/ingestion/inventory-scan.ts`,
`lib/db-map/sql/ingestion-control.ts`, `lib/db-map/lib/ingestion/queue.ts`,
`lib/db-map/sql/ingestion-inventory.ts`, and ingestion host-identity helpers.

- Reserve a distinct named advisory key for inventory scan serialization, for
  example unused `(91832,3)`. Preserve the worker/drain key `(91832,1)` and admission
  mutex `(91832,2)`. Centralize/document the key allocation so another feature
  cannot repeat the collision. Refresh must serialize with another refresh while
  remaining compatible with live managed workers.
- Return structured scan-busy/error evidence. Do not label worker-lock contention
  as another scanner. Preserve the previous successful inventory on failed scans.
- Make full-run recommendations reflect the standing uncapped policy and supported
  completion strategy. Full continuations should explicitly carry `--unlimited`;
  optional finite budgets remain explicit operator choices. Derive effective
  settings from the latest execution while retaining original scope/history.
  Samples retain their fixed cohorts and development bounds.
- Add stable, nonsecret installation identity for new local workers/jobs and
  verified legacy-host reconciliation. Preserve the conservative `remote_unknown`
  fallback; do not equate arbitrary DNS names merely by the first label. Signal
  authorization must still verify PID, process start, command and host evidence.

Acceptance: shared worker lock plus inventory refresh succeeds; a concurrent second
scan returns a truthful busy response; maintenance still drains/blocks admission;
uncapped resume arguments preserve the original cohort; hostname changes do not
authorize reconciliation or signals against an unrelated process.

### 2. Expose one shared operations snapshot for agents and the dashboard

Ownership: shared typed projection under `lib/db-map/lib/ingestion/`, its queries
under `lib/db-map/sql/`, CLI scripts/package exports, `scripts/coordinator_ingestion.py`,
and `apps/ingestion/server.ts`. Local journals/intents remain helper-owned.

Proposed entry points are `ingest:overview --json` and loopback
`GET /api/overview`. These do not exist yet. Both consume the same assessment;
the CLI remains usable while the dashboard is closed. Compose the database
projection with local supervisor/intent evidence through a bounded shared adapter.
Keep existing focused inventory/status/control/trace commands for drill-downs.

The versioned contract should contain:

- Schema version, database observation timestamp, per-component observation times,
  checkout/commit identity, last successful scan and latest failed/in-progress scan.
  Validate the public payload with a published schema and compatibility fixtures.
- Summary counts over intended imports; separate complete, active, partial,
  unstarted, review, intentional exclusions, missing/changed and unknown states.
- Active runs joined to exact execution/job/intent IDs, with heartbeat age, source
  lock evidence, supervisor health/result status, identity confidence and explicit
  contradictions. Missing or timed-out components remain unknown, not empty.
- Each file's hash/category/source/disposition, extraction completeness and total
  certainty, current stage-output counts, verification scope, quality flags, latest
  execution, compatible full-file continuation, and bounded evidence links.
- Structured issue codes and scope (`record`, `file`, `source`, `global`), e.g.
  `scan_stale`, `identity_unknown`, `provider_cooldown`, `geocode_blocked`,
  `schema_failure`, `lineage_invalid`, `launch_unresolved`. Include retryability,
  first/last occurrence, pinned inspect arguments and actionable next step.
- A top-level decision such as `wait_for_active_run`, `inspect_terminal_failure`,
  `review_file`, `verify_file`, `start_file` or `none`, with reason codes and argv
  arrays. Any launch recommendation stays advisory; actual admission/locks are
  checked again at launch. An active healthy run should recommend waiting even
  when historical resolved errors remain visible.

Use a consistent read-only transaction for database evidence. Local filesystem and
process evidence cannot share that transaction; expose their observation interval
and contradictions. Default output should be compact, with explicit file/category
filters, bounded detail and pagination; avoid returning raw prompts, responses and
all attempts on every poll. Apply query/overall timeouts and benchmark at the
current 247-file/43k-record scale before choosing performance thresholds.

Acceptance: one CLI call explains all 247 files and the active Dyrt job; a later
smoke selection cannot hide full-file continuation; dashboard and CLI assessments
match for the same snapshot; a lost launch response, missing journal, database
timeout or remote-unknown identity never produces safe-to-launch by omission.

### 3. Make freshness and committed progress observable

Ownership: inventory scan receipts/migration if needed, existing execution/attempt
queries, supervisor health evaluation and shared overview projection.

- Persist scan attempt start/finish/outcome, scanner identity, checkout commit,
  discovered count and errors. A failed scan must not reset last-success freshness
  or mark absent files missing. Scanning remains metadata-only and provider-free.
- Expose per-stage selected, checkpointed, reused, completed, pending, skipped,
  blocked and failed counts deduplicated by target. Label record-output evidence
  separately from historical invocation attempts and preparation-time estimates.
- Include last committed unit/time, active unit start/age, recent committed
  throughput, provider-request latency, cooldown deadline/retry state, cache reuse,
  known cost and unknown-cost count. Attribute metrics to the execution/provider;
  cost coverage must remain explicit where matching/fusion is uninstrumented.
- Report active-but-progressing, waiting-provider and progress-suspected-stalled
  separately from heartbeat freshness. Account for legitimate provider timeout,
  cooldown, machine sleep and scan/report stages before classifying a stall.
  Suspicion is diagnostic evidence and does not authorize automatic termination.
- Extend ordinary Node supervision to persist deterministic health issues and
  terminal events. Existing scheduled passes reconcile them; opening the GUI is
  unnecessary. Preserve the selected no-immediate-callback strategy and avoid
  high-frequency AI monitoring, auto-relaunch or automatic scope expansion.

Acceptance: a fresh heartbeat with no commits is visible; a supported cooldown
does not falsely trigger worker replacement; resumed attempts do not double-count
records; progress and issue events survive closing the dashboard.

### 4. Present the same answers clearly to humans and assess data completeness

Ownership: `apps/ingestion/public/`, shared assessment and reviewed source metadata
under `data/poi-research/`; operational documentation remains in its existing owners.

- Add an active-import panel showing file, stage progress, last committed unit,
  health, job/run identity and any current wait reason. Show per-stage counts
  alongside verified coverage; do not create an overall completion percentage by
  treating stages as equally expensive.
- Add filters for intended/unstarted/active/partial/review/complete and exclusions,
  and separate scan age from database refresh age. Preserve drafts and optimistic
  classification edits.
- Show degraded/excluded/stale and quality-review state beside structural
  completion, with record traces and bounded issue samples.
- Add a reviewed expected-source/capture catalog with category, intended source,
  required/optional status and reason for exclusions/replacements. Compute category
  completeness from that catalog plus current file/record evidence and recorded
  quality review. Do not silently classify the ten review files by folder name.
- Expose the full per-file backlog through the shared view/export rather than
  repeatedly writing static counts into project notes.

Acceptance: a developer or fresh agent can answer what is running, what remains,
what needs intervention, why a file is excluded, and what evidence makes a file or
category complete without opening raw logs.

## Validation and operational rollout

Implementation must follow the runbook's maintenance workflow before runtime,
schema or shared-data edits. Retain the token, request graceful stop, and confirm
process/lock quiescence; use the current worker's durable journals for recovery.
This assessment intentionally leaves the healthy full import running. Implement
with an explicit stop/resume handoff or at the next natural terminal boundary.

Use mocked providers/clocks and isolated fixtures for contract, stale/fresh worker,
hostname, conflicting job/intent, sample-vs-file, retry counting, failed scan,
concurrent scanner and degraded-complete cases. Real lock tests should use two
database sessions without provider calls. Run the existing inventory/queue/control/
supervisor tests and relevant type/contract checks; schema changes require the
normal migration/schema/generated-artifact workflow. Avoid live global resets.
After reopening admission, perform one appropriate bounded smoke if changed
runtime behavior requires it, then inspect snapshot compatibility before a full
resume. Do not drain the backlog as a visibility test.

First implementation handoff: step 1 plus the compact CLI contract in step 2.
Then add durable scan/progress health, followed by dashboard and category-quality
presentation. The stored plan does not implement these changes or authorize a
new import during this inspection.

## Evidence and design references

Private diagnostic snapshots for this assessment are retained on the inspection
host under `~/.local/state/map-ingestion-audits/2026-10-12-visibility/`. They include
inventory, queue, pinned run status, dashboard response, fresh discovery hashes,
lock evidence and research output; they are not a new runtime authority.
The active job and exact execution journal remain in the existing ignored
`lib/db-map/.ingest-jobs/` and `.ingest-logs/` directories in the primary checkout.

- [PostgreSQL advisory-lock semantics](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
  confirm why exclusive scan acquisition conflicts with the worker's shared lock
  at the same key. A distinct scan key preserves both kinds of serialization.
- [Prometheus instrumentation guidance](https://prometheus.io/docs/practices/instrumentation/)
  supports tracking stage counts, last progress/success and duration. This plan
  derives those observations from existing durable evidence first. If a metrics
  exporter is later justified, keep source-record/run UUID detail in logs/traces
  and bounded drill-downs rather than unbounded metric labels.
- [JSON Schema dialect declaration](https://json-schema.org/understanding-json-schema/reference/schema)
  supports an explicit schema dialect for validation. Payload `schema_version`
  is a separate application compatibility version.
