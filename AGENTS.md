# POI Map

Interactive POI map - letting the user search and filter points of interest on a world map.

- Public user-facing app is like Google Maps, Yelp, Zillow, ParaglidingMap, Campgrounds Search, and other typical apps that render many locations on a map - let the user search and filter the results on the map.
- Hard part is collecting and maintaining POI data. To add POIs (points of interests) to this map, we need to develop and maintain a system to ingest raw source data files (.json or .csv data dumps), normalize the raw data into our standard format, filter for quality and completeness, aggregate by number of sources, and add value like geo code location, clearer description, and category.

# Development

This is a monorepo. Apps live in `apps/`; shared libraries live in `lib/`.

- ./working directory contains project management tasks, specs, plans, and notes. You own this folder. Please add, edit, and rearrange the files as you edit the codebase. Keep this project management status and progress up to date.
- ./data folder contains raw POI data from multiple sources - it is unfinished, needs to be processed. This data is committed to the repository, with the intention of being normalized, analyzed, aggregated, converted to our custom data format, and saved to our database to be displayed on the map in the user-facing app. Please help to keep any documentation files and notes (such as AGENTS.md) up to date, to describe the raw files and what needs to be finished.

## Railway development and deployment

Railway Infrastructure as Code is owned by `.railway/railway.ts`; the full human and
agent workflow is in `.railway/README.md`. The TypeScript file is evaluated by the
Railway CLI and official `railwayapp/config` GitHub Action. It is not read during an
ordinary source deployment, and the deprecated dashboard **Railway Config File** field
must stay unset.

- Run `pnpm install` before Railway work. The repository pins `@railway/cli` and
  `railway`, and pnpm is allowed to run only the CLI's required binary installer in
  addition to the existing approved build dependencies.
- Validate every IaC edit with `pnpm railway:config:check` and
  `pnpm railway:config:plan`. A plan is read-only. Confirm it targets project `World`
  and environment `dev`, contains no unexpected deletes, and preserves live variables.
- Local humans and interactive agents authenticate with `pnpm railway:login`, then run
  `pnpm railway:link:dev`. Cloud agents and CI use an injected `RAILWAY_TOKEN` scoped to
  `dev`; never print, commit, copy into prompts, or persist that token in project files.
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
- Railway PR Environments inherit `dev`. Focused and bot PR environments are enabled.
  Source changes receive ephemeral previews; IaC changes are planned against `dev` and
  take effect after merge, so a preview created before the IaC apply retains its cloned
  configuration unless it is synced or recreated.

# Ingesting new POI data

Raw source POI data will be ingested by a CLI script. It is a long-running process. Stop and report back if it encounters a problem so we can troubleshoot and fix or improve the process.

1. Smart AI model (Terra) should orchestrate sub-agents to run the scripts, decide on success or failure of each step, decide to start from the beginning or resume a process if it previously ended prematurely. Communicate on the status and health of the process. Recommend next steps - to make code improvements, to fix data, to start over, how to resume data collection at the last spot where it previously failed.
2. Cheap AI model (Luna) should run the script, monitor progress, and report back success or failure details and logs.

You may also be an advanced AI model (Sol or Astra) that makes development decisions, owns and edits this codebase, and works with the human developer to improve this process. You may run the CLI scripts, but alway limit to just a short subset of records, only for testing and troubleshooting. Real long-running ingestion scripts should be run by cheaper AI agents.

Refer back to your prompt to understand if you are the orchestrator or the runner. Act according to your role.

## Processing source data

- [README.md](README.md): human setup and commands for manually running full ingestion.
- [Ingestion runbook](poi-ingestion.md): shared reference for stage behavior,
  command limits, category completeness, evidence, and troubleshooting. Read it before
  developing, debugging, or running ingestion.
- [Database guide](lib/db-map/AGENTS.md): database and ingestion implementation rules.
- [Source data guide](AGENTS.md): capture format and source file conventions.
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

## Economical long-run orchestration

Read [agent ingestion operations](ingestion-agents.md) for the interface, handoff template,
notification setup, and recovery limits. The following model rules narrow the execution preference
above; operational ownership does not authorize wasting expensive model time.

- The expensive orchestrator (including GPT-6 Astra and GPT-5.6 Sol) makes decisions and repairs
  code/data. **Never launch full ingestion directly.** Explicitly delegate the approved scope to
  `ingestion-runner` / `gpt-5.6-luna` with low reasoning and minimal context. Do not let model
  inheritance silently select the expensive parent, or substitute a bigger runner model.
- Direct ingestion tests use `ingest:supervise smoke`, a NEW 1–5 record cohort and an expected
  runtime under 45 seconds. Set provider budgets and stop-after as appropriate. The supervisor
  enforces a maximum 60-second deadline plus termination grace. A timed-out test needs diagnosis;
  never repeatedly launch small batches to finish a full import.
- The cheap runner launches `ingest:supervise start` with a verified parent callback and the exact
  approved scope, budgets and deadline. Ordinary code owns waiting and hourly health checks.
  Neither agent should poll, stream logs, run sleep/wait loops, or create an expensive recurring
  automation to stay alive. Return the launch receipt, then **end the turn**. No healthy status
  report should invoke a model. No automatic ingestion relaunch, scope expansion, or backlog drain.
  Bounded in-process provider recovery is owned by ordinary pipeline code; see the runbook's
  transient normalization provider recovery section. A healthy cooldown does not need an agent.
- Only a terminal result/error should start a new expensive decision turn. Keep the handoff and
  report compact (about 150 words); retain raw logs locally. Check the stable event ID to avoid
  handling duplicate notifications. Verified database completion, not exit zero alone, is success.
- Verify the host supports the notification path before unattended launch. A cheap subagent's
  launch receipt is not proof of later wake-up. If unavailable, report that limitation; do not
  silently use `--local-only`, an independent app server, or expensive polling as a substitute.
  Local-only detached operation is for humans or a separately verified notification integration.
- Token-efficient supervision does not limit ingestion provider bills. Preserve explicit provider
  budgets. Preserve maintenance, process identity, evidence and resume rules below.
- On terminal provider-recovery exhaustion, inspect its recorded bound and provider error;
  do not repeatedly delegate resumes against an unresolved outage. Carry forward the exact
  execution's remaining budgets (including failed/repair requests and diagnostic spending),
  review unknown costs, and preserve the originally approved scope and total deadline.

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

## Research and report

If something went wrong, stop and report back. Include all info, data, and logs.
If unsure about something, research, search the web, find latest techniques and best practices.
