# @lib/db-map — agent instructions

Database-first package consumed by the app and import scripts. Follow the
[root agent workflow](../../AGENTS.md); use the [package README](README.md) for layout and
schema commands. Read the [ingestion runbook](../../docs/poi-ingestion.md) before ingestion
work. It owns command semantics, limits, completion criteria, and troubleshooting.

## Agent execution cost

Follow the root model/delegation rules and [agent operations](../../docs/ingestion-agents.md).
Full ingestion belongs to the explicit cheap runner; the expensive engineer only runs short,
time-limited smoke selections. Do not add model calls to progress/heartbeat/health loops.
`supervise.ts` owns detached jobs and terminal evidence; `supervisor-process.ts` owns live child
groups; `codex-notify.ts` is the optional verified parent transport. Keep monitoring deterministic,
notification failures durable, delivery conservative, and resume decisions with the orchestrator.
Never use a persisted PID as signal authorization, auto-relaunch an abandoned job, or report
terminal delivery as proven without a transport receipt. Tests must mock parent wake-ups.
`provider-recovery.ts` owns bounded managed normalization cooldowns. Keep failed attempts
append-only, recheck budgets on each retry, preserve heartbeat/stop responsiveness, and never
retry authentication, validation or database failures as provider throttling. Use mocked
clocks/providers for failure injection, not paid long-running outage tests.

## Database changes

- Agents are authorized to operate human- or agent-started workers and apply needed schema/data
  repairs. Before runtime/schema/data changes, enter maintenance through `ingest:control`,
  confirm quiescence, and keep admission closed until edits and static checks are complete.
  Follow the root workflow; do not infer that a stale heartbeat grants exclusive ownership.
- Put application queries in `sql/`; use those helpers from the app.
- Use migrations for schema changes. Create one with
  `pnpm --filter @lib/db-map db:migration:new -- description`.
- Run `pnpm --filter @lib/db-map db:sync` after schema changes and include the migration,
  schema snapshot, and generated types/contracts in the same change. Do not hand-edit
  generated artifacts. The snapshot requires a `pg_dump` matching the server major version.
- Update `contracts/map-app.ts` if API payloads change; run
  `pnpm --filter @lib/db-map check-types` to check types and app contract drift.
- Schema uses plain coordinates, `real[]` embeddings, and `pg_trgm`; no PostGIS/pgvector.
  There is no unique coordinate constraint: identity is determined by matching.

## Ingestion implementation map

Paths below are relative to `scripts/ingest/` unless shown otherwise.

| Concern                                                 | Start here                                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CLI options, stage dispatch, run checkpoints            | `run.ts`, `orchestrator.ts`, `execution.ts`                                                       |
| Execution history, locking, heartbeat, pause            | `execution.ts`, `pause.ts`, `recovery.test.ts`                                                    |
| Pending work selection and batched cache reuse          | `work-queue.ts`, `work-queue.test.ts`                                                             |
| Process discovery, stop-and-wait, maintenance admission | `control.ts`, `../../sql/ingestion-control.ts`, `control.test.ts`, `control.integration.ts`       |
| Source/file resolution, stable IDs, parsing             | `source-file.ts`, `sources.ts`, `extractors/`, `io.ts`                                            |
| Taxonomy and provider configuration                     | `taxonomy.ts`, `config.ts`, `providers/`                                                          |
| Normalization selection, caching, activation            | `normalize/runner.ts`                                                                             |
| Deterministic facts and LLM evidence validation         | `normalize/deterministic.ts`, `normalize/resolve.ts`                                              |
| Profiles, prompt, examples, output contract             | `normalize/profiles.ts`, `normalize/prompt.ts`, `normalize/examples.ts`, `normalize/contracts.ts` |
| Geocoding and embedding eligibility/budgets             | `geocode.ts`, `embed.ts`                                                                          |
| Match selection and decision routing                    | `match.ts`, `match/score.ts`, `match/ids.ts`, `match/llm.ts`                                      |
| Global canonical consolidation                          | `match/consolidate.ts`, `match/anchors.ts`, `match/canonicals.ts`                                 |
| Published canonical fields and builds                   | `merge.ts`                                                                                        |
| Status, lineage, integrity                              | `status.ts`, `report.ts`, `trace.ts`, `verify.ts`, `../../sql/lineage.ts`                         |
| Artifact versioning                                     | `pipeline-versions.ts`, `normalize/contracts.ts`, source/profile versions                         |
| Targeted cleanup and legacy reflow                      | `clean.ts`, `reflow.ts`                                                                           |

Inventory/discovery lives in `lib/ingestion/inventory-scan.ts`, shared coverage assessment in
`lib/ingestion/assessment.ts`, and application queries in `sql/ingestion-inventory.ts`.
`apps/ingestion` and `scripts/ingest/inventory.ts` must consume the same assessment. Preserve
operator notes/classification on scans; never infer full-file completion from the latest sample.

## Invariants to preserve

- Require an explicit code-owned category at ingestion. Keep `(source_id, source_record_id)`
  stable; do not silently coalesce different source records. Preserve raw observations and
  their provenance. Use the generic capture-spec extractor when the format conforms.
- Managed runs freeze their record/observation cohort. Each invocation appends an execution;
  each retry appends an attempt with input IDs, output IDs, timing, and structured errors.
  Never overwrite prior failures or advance past an unsuccessful required stage. Only mark
  success after reporting and verification. Keep stage data writes atomic; recovery is
  at-least-once, so do not promise exactly-once provider calls.
- Managed workers must pass the maintenance admission gate and hold their worker/source locks
  through finalization. Check maintenance during heartbeats. Keep operator actions auditable;
  never report pause requests as confirmed stops or reconcile a live/unknown PID as dead.
  Use managed orchestration for writable diagnostics; standalone scripts are legacy interfaces
  without cross-host lifecycle registration and require explicit process discovery.
- Preserve resumability and idempotency. A refresh failure must leave prior valid output
  available. Snapshot retirement requires a complete successful extraction, never a limited
  sample. See the runbook for current cache and retry limitations.
- Select unfinished records from durable per-record attempts; a maximum source ID or offset
  can hide earlier failures. Reuse exact active caches in batches without reactivating artifacts
  or rebuilding canonicals. Preserve one audit attempt per reused record and keep cache identity
  checks shared with the normal stage implementation.
- Validate model output against source evidence. Coordinates come from source/URL evidence
  or geocoding, never LLM guesses. A deterministic-only run does not validate the LLM path.
- Active `research_canonical_memberships` are authoritative; `canonical_poi_id` is a lookup
  cache. Keep both consistent. Canonical builds retain their inputs in
  `canonical_poi_build_inputs`; use `ingest:verify` after lineage or membership changes.
- Rebuild canonical output from linked research rows; preserve audit decisions, manual
  overrides, and redirects. Do not patch published fields just to conceal an upstream bug.
- When changing outputs, check the actual cache keys and invalidation path. Version constants
  alone do not guarantee a stage reruns. Prove the affected sample recomputes and then resumes
  without unnecessary provider calls.

## Validation and diagnostic tooling

Use the bounded recipes and existing checks in the runbook. Read the CLI parser before
adding flags to a command; some scripts reject unknown flags and others silently ignore them.

When implementing diagnostic controls, make scope and bounds explicit at every invoked
stage. Print selected/processed/skipped/failed counts, stop reason, and a usable resume
command. A row limit must not silently permit an unbounded downstream sweep. Keep read-only
status and record-level error evidence available so agents can diagnose a failure without
rerunning the full job. When a control is missing or misleading, document the current limit
and fix it as part of the relevant development task.

Direct KML/JSON importers are for small curated fixtures; real source data belongs in the
staged pipeline. Source capture conventions live in [docs/AGENTS.md](../../docs/AGENTS.md).
