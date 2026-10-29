# Project: POI Map

Interactive POI map - letting the user search and filter points of interest on a world map.

- Public user-facing app is like Google Maps, Yelp, Zillow, ParaglidingMap, Campgrounds Search, and other typical apps that render many locations on a map - let the user search and filter the results on the map.
- Hard part is collecting and maintaining POI data. To add POIs (points of interests) to this map, we need to develop and maintain a system to ingest raw source data files (.json or .csv data dumps), normalize the raw data into our standard format, filter for quality and completeness, aggregate by number of sources, and add value like geo code location, clearer description, and category.

## Development

This is a monorepo. Apps live in `apps/`; shared libraries live in `lib/`.

The ingestion monitoring dashboard in `apps/ingestion` is a private internal tool,
run only on this computer or through an approved-device private Tailscale proxy;
it is never a public admin service. local-dev iframe previews are intentional.
Keep its existing lightweight request checks and framing policy, but do not add
public-hosting authentication or security infrastructure without a separate request.
See [dashboard framing](apps/ingestion/docs/framing.md).

- ./working directory contains project management tasks, specs, plans, and notes. You own this folder. Please add, edit, and rearrange the files as you edit the codebase. Keep this project management status and progress up to date.
- ./data folder contains raw POI data from multiple sources - it is unfinished, needs to be processed. This data is committed to the repository, with the intention of being normalized, analyzed, aggregated, converted to our custom data format, and saved to our database to be displayed on the map in the user-facing app. Please help to keep any documentation files and notes (such as AGENTS.md) up to date, to describe the raw files and what needs to be finished.

## Railway development and deployment

Railway Infrastructure as Code is owned by `.railway/railway.ts`; the full human and
agent workflow is in `.railway/README.md`, and the reusable agent procedure is in
`.agents/skills/railway-iac/SKILL.md`. The TypeScript file is evaluated by the
Railway CLI and official `railwayapp/config` GitHub Action. It is not read during an
ordinary source deployment, and the deprecated dashboard **Railway Config File** field
must stay unset.

- Run `pnpm install` before Railway work. The repository pins `@railway/cli` and
  `railway`, and pnpm is allowed to run only the CLI's required binary installer in
  addition to the existing approved build dependencies.
- Validate every IaC edit with `pnpm railway:config:check` and
  `pnpm railway:config:plan`. A plan is read-only. Confirm it targets project `World`,
  the intended environment, contains no unexpected deletes, and preserves live variables.
- Local humans and interactive agents authenticate with `pnpm railway:login`, then run
  `pnpm railway:link:dev` or `pnpm railway:link:production`. Cloud agents and CI use an
  injected `RAILWAY_TOKEN` scoped to exactly one environment; never print, commit, copy
  into prompts, or persist that token in project files.
- Use `pnpm railway:config:export` to inspect the live graph without replacing the
  authored file. Never run `railway config pull --force` over a dirty or reviewed
  `.railway/railway.ts`; if a full import is necessary, preserve the current file and
  reconcile every resource and `preserve()` variable before planning.
- Do not clear dashboard build/deploy values after IaC is applied. They are the live
  state rendered from the authoring file. Change the TypeScript definition and apply it.
- Normal changes go through a pull request. The official action posts a pinned plan and
  merge applies that exact artifact. Do not apply a competing dashboard or CLI change
  while a plan is awaiting merge; Railway rejects stale plans on environment drift.
- Direct `pnpm railway:config:apply` is for initial bootstrap or an explicitly requested
  recovery. Review the fresh plan, apply, run the plan again until it reports no changes,
  then verify the deployment and `/api/health`.
- The dev service is `apps/map` from `main`; the production service is `map` from `prod`.
  Keep shared build/deploy behavior identical and express these environment differences
  through `ctx.isEnvironment("production")` in the IaC definition.
- Railway PR Environments inherit `dev`. Focused and bot PR environments are enabled.
  Source changes receive ephemeral previews; IaC changes are planned against `dev` and
  take effect after merge, so a preview created before the IaC apply retains its cloned
  configuration unless it is synced or recreated.

# Ingesting new POI data

Raw source POI data will be ingested by a CLI script. It is a long-running process. Stop and report back if it encounters a problem so we can troubleshoot and fix or improve the process.

The native Codex scheduled coordinator decides scope, reconciles terminal evidence and
chooses an authorized next action. Ordinary Node supervision owns long-running workers,
waiting and health checks; no AI model stays alive to monitor a healthy import. Coding
agents develop and diagnose with bounded selections. Follow the prompt's role and the
native scheduled exception below before launching full work.

## Processing source data

- [README.md](README.md): human setup and commands for manually running full ingestion.
- [Ingestion runbook](data/poi-ingestion.md): shared reference for stage behavior,
  command limits, category completeness, evidence, and troubleshooting. Read it before
  developing, debugging, or running ingestion.
- [Database guide](lib/db-map/AGENTS.md): database and ingestion implementation rules.
- [Source data guide](data/AGENTS.md): capture format and source file conventions.
- Read the applicable folder `AGENTS.md` before editing there. App guides start at
  `apps/AGENTS.md` and `apps/map/AGENTS.md`, with narrower guides under `apps/map/src/`.

Keep setup and full-run recipes in READMEs, agent working rules in AGENTS.md, and shared
pipeline facts in the runbook. Link to the owner instead of copying its command catalog.
When behavior changes, update that reference in the same change.

## Execution responsibilities

Agents and humans share full operational ownership of the **entire** experimental ingestion
pipeline and database. Agents have standing authorization to start, pause, stop, resume, and
restart ingestion processes, including human-started runs; modify scripts and schema; apply
migrations; and repair, reprocess, or reset experimental data when necessary for the task.
Do not ask again for routine operational permission. Preserve diagnostic evidence before
destructive repairs, explain their scope, and prefer the smallest effective change.

Humans usually launch long imports manually; agents usually validate with short selections.
This is an execution preference, not an ownership boundary. Agents may control full runs when
the requested operation requires it, but must not silently turn a debugging task into a full
backlog drain or unbounded provider spend. Keep the user informed of stops and restarts.

Agents should autonomously inspect code and data, run read-only diagnostics, implement fixes,
and execute short, bounded validation within the requested task. Small live database writes
and provider calls needed to validate ingestion are allowed. Start with 1–5 records for
provider-backed work or up to 20 for deterministic checks; expand only when evidence requires
it. These are starting budgets, not a guarantee of runtime.

Before running a command, check its actual scope, selection, provider behavior, and stopping
conditions in the runbook/code. `--dry-run` does not imply fast or provider-free, and
`--limit` on managed `ingest:run` fixes the record cohort across every record stage.
Global consolidation is opt-in and incompatible with limited runs. Standalone stage commands
have different semantics; prefer managed `--record` / `--limit` and `--stop-after`.
Do not launch an unrelated full run or chain small batches until the backlog is drained.
When full execution is part of the task, state its scope and use the managed interface;
otherwise prepare the exact manual command after validation.

If a stage lacks a suitable bound or cannot select the failing records, investigate with
read-only queries and fixtures, then add or fix the diagnostic control when needed for the
task. The human/agent split is about typical execution duration, not code or process ownership.

## Discover and coordinate ingestion jobs

Any agent asked to inspect or manage ingestion, including a scheduled coordinator, starts
with this procedure. Use the primary map checkout for live operations. From its root, run
`python3 scripts/coordinator-ingestion.py snapshot` once to discover database workers/locks,
supervised jobs and launch intents; use the guides below for command details.

- Find the relevant job by its run/execution IDs and timestamps. Follow the snapshot's
  `journal` and `result_path` to `lib/db-map/.ingest-jobs/<job UUID>/job.json` and
  `result.json`. Use `pnpm --silent --filter @lib/db-map ingest:status --run <run UUID>
--json --limit 10` to identify source/file, stage and failure evidence. Read relevant log
  excerpts only; the matching event journal is
  `lib/db-map/.ingest-logs/<run UUID>-<execution UUID>.jsonl`. Do not guess from filenames.
- Inspect unresolved snapshot `claims` and, if present,
  `lib/db-map/.ingest-jobs/.coordinator/imports/active.claim` plus its matching
  `imports/<intent UUID>/intent.json`. These record launch ownership and the job receipt.
  `ingestion-acceptance.json` and `observations/` are setup/discovery evidence used by the
  current start gate; they do not prove present worker health or completion.
- Preserve healthy imports. For failed, stalled or conflicting evidence, pin the exact IDs
  and diagnose before stop/resume/retry. Use the helper's `stop` and `release` interfaces;
  confirm process/lock exit and terminal evidence. A lost launch response must be reconciled
  against existing jobs and workers before another start. Never discard a claim by age.
- When continued ingestion is in scope and no unresolved worker/launch blocks it, use
  `pnpm --silent --filter @lib/db-map ingest:queue --json` for eligible work. Verify whole-file
  completion before advancing, and follow the full-launch and maintenance rules below.
- Tools own job/intent records. Keep raw logs and diagnostic evidence private; report actual
  IDs, findings, actions and next steps in the current chat. Scheduled-run memory may link
  these records, but fresh project evidence governs each decision. Both runtime directories
  are Git-ignored; no automatic retention cleanup exists. Preserve active/unresolved records
  and evidence needed for recovery; do not prune them during an ordinary inspection pass.

## Economical long-run orchestration

Read [agent ingestion operations](data/ingestion-agents.md) for durable process control,
notification alternatives and recovery limits. Ordinary Node owns waiting and hourly
health checks. No AI turn should stay alive to monitor a healthy import.

- Paul's native Codex desktop scheduled map coordinator is authorized to manage all intended
  `data/poi` imports, one file at a time, with uncapped provider stages and no overall deadline.
  After its verified scheduled-discovery receipt, it may launch the exact reviewed scope through
  this project's `python3 scripts/coordinator-ingestion.py start`. That wrapper uses detached
  `ingest:supervise start --local-only`, durable journals and reconciliation on ordinary
  project scheduled passes. This is an explicitly selected completion strategy; it does not
  promise an immediate callback. No cheap AI launcher or waiting subprocess is needed.
- Other expensive coding agents should delegate approved full imports to the explicitly
  configured `ingestion-runner` / `gpt-5.6-luna` with low reasoning and a verified callback,
  or prepare the manual command. Do not create high-frequency AI monitoring schedules.
- Development tests use `ingest:supervise smoke`, a NEW 1–5 record cohort and expected runtime
  under 45 seconds. Set provider budgets/stop-after as appropriate. Deadline maximum is 60s
  plus grace. Diagnose a timeout; never chain tests to drain the backlog.
- Full imports use `--unlimited`, including resumed historically capped runs, preserve original
  cohort/stages/checkpoints and have no required overall deadline. Spending/unknown-cost telemetry
  is informational; do not ask for an allowance, ETA or deadline for the standing backlog.
- Run one full import process at a time. Queue separately approved files for later launch;
  the database-wide matching lock rejects a second matcher rather than waiting. Concurrency
  settings serialize work within one Node process, not across separate import processes.
  See the runbook's operating model before proposing concurrent full-file workers.
- Record the exact job/run/execution IDs and return after launch. Reconcile existing human and
  automated workers before starting anything. Never stop a healthy worker merely to assume
  ownership. Verified whole-file/database completion, not exit zero, permits advancement.
- Diagnose terminal failures, source-lock loss or exhausted provider recovery before resuming.
  Bounded provider cooldown is owned by pipeline code; a live heartbeat does not need an agent.
  Code/script blockers go to a visible native coding task. Source-specific blockers can permit
  independent captures; global schema/provider/lineage blockers stop progression.
- Use durable supervisor stop requests and database controls, verifying actual process/lock exit.
  Preserve the maintenance, identity, evidence and resume rules below. Do not relaunch blindly
  or trust an old PID/conversation handle. No automatic process-level retry or scope expansion.

## Stop before changing a running pipeline

Before editing ingestion runtime code, prompts/profiles, source files in use, or database
schema/data that a worker could touch, use the runbook's **Process control and maintenance**
workflow. `ingest:control list --json` is the standard discovery interface. Enter maintenance,
request graceful stops, and confirm process/lock quiescence before editing. Pause requested,
stale heartbeat, and a terminal run label are not proof that a process has exited. Maintenance
blocks new managed runs and persists if the agent is interrupted. Retain its token and reason.
Do not reopen another operator's gate without coordinating ownership.

If a worker does not stop, inspect its process identity and current work. Agents may send
targeted signals when necessary, after verifying host, PID, command and process start time;
never use broad `pkill node`/`killall` or assume a saved PID still belongs to the worker.
Forced termination can lose in-flight provider results; preserve the journal and recover via
managed resume. Remote/unknown processes and standalone scripts require explicit host evidence.
Read-only diagnostics and documentation-only edits do not require stopping workers.

After changes, run checks, reopen admission with the maintenance token for bounded validation,
and verify compatibility before resuming a full run. Re-enter maintenance before further
runtime/schema edits. Report final maintenance state, stopped runs, and exact resume commands.

## Ingestion development and debugging loop

1. **Establish scope and baseline.** For “the latest run,” start with
   `pnpm --filter @lib/db-map ingest:status`, pin the returned run UUID, and follow the
   runbook’s latest-attempt investigation. Distinguish last committed output from last
   attempted work; do not trust `running` or heartbeat alone. Identify category, source,
   source files, and relevant runs. Use `ingest:inventory --refresh` to discover current files,
   then `ingest:inventory --json` for file coverage, changed/missing files, and operator notes.
   Read-only metadata discovery is allowed across the capture tree; it performs no ingestion or
   provider work. Compare expected files with observed imports, including sources with no database
   rows. Use the runbook's category assessment; zero match-ready rows alone is not completion.
2. **Find the earliest broken stage.** Inspect executions and append-only attempt history,
   including exact input/output IDs and errors. Use `ingest:run --resume <uuid>` after fixing
   the cause; it preserves completed work and the original scope. File/version changes require
   a new run. Do not infer a kill cause from a stale heartbeat. Trace representative
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
5. **Resume or hand off full execution.** Report category/source coverage, linked and match-ready
   counts, blocked/failed work, evidence of the fix, and exact full-run/resume commands.
   Explain expected changes and the read-only checks the human should run afterward.
   Clearly distinguish “sample validated” from “category complete.”

## Environment and database

Environment variables are already provided by the shell. Do not create or load `.env` files;
`.env.example` is a reference only. Use `DB_MAP_URL` without printing credentials.

For a new cloud AI-agent VM in another service, run
[scripts/agent-env.sh](scripts/agent-env.sh) after checkout (`setup`, then `start`
if that host should keep the map running). The script may persist injected secrets
into `~/.config/poi-map/agent.env` so later shells can reach the database; never
copy that file into the repository. See [working/agent-environment.md](working/agent-environment.md).

The remote database is available for development reads and writes and is backed up. Follow
the execution budgets above. After schema changes, run
`pnpm --filter @lib/db-map db:sync` and include the migration, `schema/`, and `generated/`
changes together. See the database guide for details.

Destructive reclustering or resets are authorized when necessary to the requested repair,
but are not resume shortcuts. Preserve diagnostic evidence first, document why retained
artifacts cannot be repaired, and use the runbook's cleanup procedure.

# Research and report

If something went wrong, stop and report back. Include all info, data, and logs.
If unsure about something, research, search the web, find latest techniques and best practices.

# Next steps

Consider what was recently done, what's in progress, and how it contributes to the goal.
Decide and recommend what to do next.

# Goal: to collect all the interesting places in the world

1. Develop a collection and ingestion workflow to data mine all the world's interesting places, by category
2. Display the collected POIs on a map in a web app
