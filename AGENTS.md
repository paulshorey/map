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

Read [agent ingestion operations](docs/ingestion-agents.md) for the interface, handoff template,
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

The remote database is available for development reads and writes and is backed up. Follow
the execution budgets above. After schema changes, run
`pnpm --filter @lib/db-map db:sync` and include the migration, `schema/`, and `generated/`
changes together. See the database guide for details.

Destructive reclustering or resets are authorized when necessary to the requested repair,
but are not resume shortcuts. Preserve diagnostic evidence first, document why retained
artifacts cannot be repaired, and use the runbook's cleanup procedure.
