# Project: POI Map

Search and filter the world's points of interest on a map. Ingestion captures raw
sources, normalizes and enriches records, and reconciles them with source provenance.

## Development

Apps live in `apps/`, shared libraries in `lib/`, raw captures in `data/poi`, and
plans/status in `working/`. Keep those notes and applicable nested `AGENTS.md` current.
Read [README.md](README.md), [the ingestion runbook](data/poi-ingestion.md),
[database rules](lib/db-map/AGENTS.md), and [capture conventions](data/AGENTS.md)
for the area being changed; link to owning guides instead of duplicating recipes.

`apps/ingestion` is a private local/approved-device Tailscale dashboard. Its iframe
previews are intentional; preserve lightweight request/framing checks. Public
hosting/authentication infrastructure needs a separate request. See [framing](apps/ingestion/docs/framing.md).

## Railway development and deployment

[.railway/railway.ts](.railway/railway.ts) owns IaC; follow
[.railway/README.md](.railway/README.md) and the repository Railway skill. The dashboard
Railway Config File field stays unset. Install pinned dependencies with `pnpm install`.

Validate IaC with `pnpm railway:config:check` and `pnpm railway:config:plan`; verify
project `World`, environment, deletes, and preserved variables. Humans run
`pnpm railway:login`, then `pnpm railway:link:dev` or `pnpm railway:link:production`.
CI/cloud use the exact environment's
injected `RAILWAY_TOKEN`, never persisted or printed. Export to inspect live state;
never force-pull over authored IaC or clear its rendered dashboard settings.

Normal IaC changes use PR plans applied on merge; do not compete with a pending
plan. Direct apply is for bootstrap or requested recovery: review a fresh plan,
apply, confirm no drift, and verify deployment/health. Dev is `apps/map` from `main`;
production is `map` from `prod`, selected through `ctx.isEnvironment("production")`.
PR previews inherit dev; an existing preview does not acquire later IaC changes automatically.

## Processing source data

Read [the runbook](data/poi-ingestion.md) before ingestion work and
[agent operations](data/ingestion-agents.md) before orchestration. Keep full-run
recipes in README/runbooks and implementation rules in the owning folder guide.

## Execution responsibilities

Agents and humans share operational ownership of the experimental pipeline and
database, including starts/stops, migrations, and necessary repairs/resets within
the task. Preserve evidence, explain destructive scope, and use the smallest repair;
resets are not resume shortcuts. Current user scope and holds govern execution.

Ordinary coding work uses bounded diagnostics: initially 1–5 provider-backed or up
to 20 deterministic records. Check actual selection, provider behavior, and stopping
conditions; `--dry-run` is not necessarily cheap. Managed `--record`/`--limit` pins
one cohort across stages; global consolidation is opt-in and incompatible with limits.
Prefer managed commands with `--stop-after`; fix missing diagnostic bounds before
running. Never silently drain a backlog or chain small tests into a full run.

## Discover and coordinate ingestion jobs

For any ingestion inspection/operation, use the primary checkout and run
`python3 scripts/coordinator-ingestion.py snapshot` once. Pin actual job/run/execution
IDs and timestamps; follow returned journals/results, unresolved claims, and matching
`imports/active.claim` / intent records. Inspect bounded `ingest:status` and relevant
execution-log excerpts. Acceptance/discovery receipts do not prove current health.

Reconcile workers and lost launch responses before starting again. Preserve healthy
imports; diagnose failed/stalled/conflicting evidence before stop/resume. Use helper
`stop`/`release`, verify process/lock exit, and never discard claims by age. Tools own
job/intent records; keep raw logs private and preserve active/unresolved recovery evidence.
When continued ingestion is in scope, inspect `ingest:queue --json` and verify whole-file
completion before advancing. See [coordinator details](data/ingestion-agents.md#native-codex-scheduled-coordinator).

## Economical long-run orchestration

Ordinary Node supervision owns waiting and hourly health checks; end the AI turn
after recording the launch receipt. Follow [agent operations](data/ingestion-agents.md):

- The verified native scheduled coordinator may launch reviewed `data/poi` scope
  directly through `coordinator-ingestion.py start`, one file at a time, with durable
  journals and scheduled reconciliation. Other coding agents use the configured
  `ingestion-runner` / `gpt-5.6-luna` with low reasoning and verified callback, or
  prepare the manual command. Do not add frequent AI monitoring.
- Smoke tests use a new 1–5 record cohort, expected under 45 seconds (maximum 60s
  plus grace), with suitable provider/stage limits. Diagnose timeouts before more runs.
- Full imports/resumes use `--unlimited`, preserve cohort/stages/checkpoints, and
  need no overall deadline or new backlog cost allowance. Usage telemetry is informational.
- Run only one full import process. Within-process concurrency does not permit
  parallel full-file workers. Return exact IDs; advancement needs verified file/database
  completion, not exit zero. No blind process retry or scope expansion.
- Diagnose terminal/source-lock/provider failures before resuming; pipeline code owns
  bounded cooldown. Global schema/provider/lineage blockers stop progression;
  source-specific blockers may permit independent captures.

## Stop before changing a running pipeline

Follow [process control and maintenance](data/poi-ingestion.md#process-control-and-maintenance)
before runtime, prompt/profile, in-use source, or worker-visible schema/data changes.
Discover with `ingest:control list --json`, enter maintenance, request graceful stops,
and verify actual process/lock quiescence. Retain the token/reason; do not reopen
another operator's gate. Paused labels and stale heartbeats do not prove exit.
Documentation-only edits and read-only diagnosis do not require stopping workers.

If signals are necessary, verify host/PID/command/start time first; never broadly
kill Node processes or trust old PIDs. Preserve journals and use managed recovery.
After checks, reopen with the owned token for bounded validation; verify compatibility
before full resume, and re-enter maintenance before further runtime edits. Report
maintenance state, stopped runs, and exact resume commands.

## Ingestion development and debugging loop

Pin the latest attempted execution, compare inventory with expected source files,
and trace representative records from raw input through normalization, geocoding,
embedding, membership, canonical build, and publication. Diagnose the earliest broken
stage; distinguish pending, excluded, failed, stale, and budget-limited work. Zero
match-ready rows or a heartbeat do not establish completion or a kill cause.

Fix the cause, validate affected downstream stages/lineage, and report coverage,
counts, failures, exercised provider paths, and exact resume/full-run commands.
`ingest:run --resume <uuid>` preserves scope/completed work; file-version changes
need a new run. Keep source identity, provenance, and successful artifacts intact.

## Environment and database

Use shell-provided `DB_MAP_URL`; do not create/load `.env` files or expose credentials.
New cloud VMs use [scripts/agent-env.sh](scripts/agent-env.sh) (`setup`, then `start`
only when serving is intended); its private persisted environment stays outside Git.
See [agent setup](working/agent-environment.md).

Development database reads/writes follow the budgets above. Schema changes need
`pnpm --filter @lib/db-map db:sync` plus migration, `schema/`, and `generated/` diffs.
Necessary destructive repairs require retained diagnostic evidence, a documented
reason, and the runbook cleanup procedure.

# Research and report

If something goes wrong, stop the affected operation and report relevant findings, data, and logs.
Redact secrets and private content.
If unsure about something, research, search the web, find latest techniques and best practices.

# Next steps

Consider what was recently done, what's in progress, and how it contributes to the goal.
Decide and recommend what to do next.

# Goal: Collect all the interesting places in the world

Normalize, analyze, and aggregate global POI sources, then make places discoverable
by category on an interactive map.
