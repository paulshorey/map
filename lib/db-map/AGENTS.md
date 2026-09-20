# @lib/db-map — agent instructions

Database-first package consumed by the app and import scripts. Follow the
[root agent workflow](../../AGENTS.md); use the [package README](README.md) for layout and
schema commands. Read the [ingestion runbook](../../docs/poi-ingestion.md) before ingestion
work. It owns command semantics, limits, completion criteria, and troubleshooting.

## Database changes

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

| Concern                                         | Start here                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| CLI options, stage dispatch, run checkpoints    | `run.ts`, `orchestrator.ts`                                                                       |
| Source/file resolution, stable IDs, parsing     | `source-file.ts`, `sources.ts`, `extractors/`, `io.ts`                                            |
| Taxonomy and provider configuration             | `taxonomy.ts`, `config.ts`, `providers/`                                                          |
| Normalization selection, caching, activation    | `normalize/runner.ts`                                                                             |
| Deterministic facts and LLM evidence validation | `normalize/deterministic.ts`, `normalize/resolve.ts`                                              |
| Profiles, prompt, examples, output contract     | `normalize/profiles.ts`, `normalize/prompt.ts`, `normalize/examples.ts`, `normalize/contracts.ts` |
| Geocoding and embedding eligibility/budgets     | `geocode.ts`, `embed.ts`                                                                          |
| Match selection and decision routing            | `match.ts`, `match/score.ts`, `match/ids.ts`, `match/llm.ts`                                      |
| Global canonical consolidation                  | `match/consolidate.ts`, `match/anchors.ts`, `match/canonicals.ts`                                 |
| Published canonical fields and builds           | `merge.ts`                                                                                        |
| Status, lineage, integrity                      | `report.ts`, `trace.ts`, `verify.ts`, `../../sql/lineage.ts`                                      |
| Artifact versioning                             | `pipeline-versions.ts`, `normalize/contracts.ts`, source/profile versions                         |
| Targeted cleanup and legacy reflow              | `clean.ts`, `reflow.ts`                                                                           |

## Invariants to preserve

- Require an explicit code-owned category at ingestion. Keep `(source_id, source_record_id)`
  stable; do not silently coalesce different source records. Preserve raw observations and
  their provenance. Use the generic capture-spec extractor when the format conforms.
- Preserve resumability and idempotency. A refresh failure must leave prior valid output
  available. Snapshot retirement requires a complete successful extraction, never a limited
  sample. See the runbook for current cache and retry limitations.
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
