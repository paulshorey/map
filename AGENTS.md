# POI Map — agent instructions

Interactive POI map monorepo. Apps live in `apps/`; shared libraries live in `lib/`.

## Read the right guide

- [README.md](README.md): human setup and commands for manually running full ingestion.
- [Ingestion runbook](docs/poi-ingestion.md): shared reference for stage behavior,
  command limits, category completeness, evidence, and troubleshooting. Read it before
  developing, debugging, or running ingestion.
- [Database guide](lib/db-map/AGENTS.md): database and ingestion implementation rules.
- [Source data guide](docs/AGENTS.md): capture format and source file conventions.
- Read the applicable folder `AGENTS.md` before editing there. App guides start at
  `apps/AGENTS.md` and `apps/map/AGENTS.md`, with narrower guides under `apps/map/src/`.

Keep setup and full-run recipes in READMEs, agent working rules in AGENTS.md, and shared
pipeline facts in the runbook. Link to the owner instead of copying its command catalog.
When behavior changes, update that reference in the same change.

## Execution responsibilities

The human runs long ingestion, bulk reprocessing, global consolidation, and large backfills
manually. Agents own development and debugging of the **entire** pipeline, including those
long-running stages. Do not stop at describing a problem or hand off a reproducible code bug.

Agents should autonomously inspect code and data, run read-only diagnostics, implement fixes,
and execute short, bounded validation within the requested task. Small live database writes
and provider calls needed to validate ingestion are allowed. Start with 1–5 records for
provider-backed work or up to 20 for deterministic checks; expand only when evidence requires
it. These are starting budgets, not a guarantee of runtime.

Before running a command, check its actual scope, selection, provider behavior, and stopping
conditions in the runbook/code. `--dry-run` does not imply fast or provider-free, and
`--limit` does not necessarily bound every stage. In particular, file-first runs invoke
global consolidation when they reach matching. Use the runbook's bounded stage recipes.
Do not launch a full run in the background or chain small batches until the full backlog
is drained. Prepare the exact manual command when validation is complete.

If a stage lacks a suitable bound or cannot select the failing records, investigate with
read-only queries and fixtures, then add or fix the diagnostic control when needed for the
task. The human/agent split is about execution duration, not which code agents may work on.
Do not interfere with a human's active run; check run state and process/lock evidence before
starting overlapping mutations.

## Ingestion development and debugging loop

1. **Establish scope and baseline.** Identify category, source, source files, and relevant
   runs. Compare expected files with observed imports, including sources with no database
   rows. Use the runbook's category assessment; zero match-ready rows alone is not completion.
2. **Find the earliest broken stage.** Inspect run counters/errors and trace representative
   records from raw observation through normalization, geocoding, embedding, membership,
   canonical build, and published output. Distinguish pending, excluded, failed, stale,
   budget-limited, and intentionally skipped work.
3. **Reproduce and fix.** Use the smallest useful sample. Preserve source identity,
   provenance, resumability, and successful prior artifacts. Fix the responsible code,
   profile, prompt, query, or source mapping instead of repeatedly rerunning the pipeline.
4. **Validate through the affected downstream stages.** Run relevant existing checks and
   bounded live diagnostics. Compare before/after counts and record traces; verify lineage
   after membership/build changes. Measure quality, time, requests, cache hits, and cost
   when optimizing. State which stages and provider paths were actually exercised.
5. **Hand off full execution.** Report category/source coverage, linked and match-ready
   counts, blocked/failed work, evidence of the fix, and exact full-run/resume commands.
   Explain expected changes and the read-only checks the human should run afterward.
   Clearly distinguish “sample validated” from “category complete.”

## Environment and database

Environment variables are already provided by the shell. Do not create or load `.env` files;
`.env.example` is a reference only. Use `DB_MAP_URL` without printing credentials.

The remote database is available for development reads and writes and is backed up. Follow
the execution budgets above. After schema changes, run
`pnpm --filter @lib/db-map db:sync` and include the migration, `schema/`, and `generated/`
changes together. See the database guide for details.

Do not use `--recluster` unless the user explicitly asks to start over or approves destructive
reclustering. It is not a resume or debugging shortcut. Preserve diagnostic evidence before
any targeted cleanup; use the runbook's cleanup procedure when removal is part of the task.
