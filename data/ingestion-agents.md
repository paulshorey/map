# Economical agent operation of ingestion

The orchestrator decides scope and repairs failures. The verified native scheduled coordinator
launches exact scope directly; other environments use a GPT-5.6 Luna launcher with verified delivery. A detached Node process owns the ingestion worker, waits for exit, and checks
its database heartbeat/progress once an hour. **No model is invoked for healthy monitoring.**
On termination, a compact evidence packet can wake the original orchestrator through a verified
Codex app-server connection. The existing database checkpoints remain the source of resume truth.

## Roles and cost boundaries

| Role               | Work                                                     | Bound                                                               |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Smart orchestrator | Inspect, decide, develop, repair, delegate               | Native scheduled exception below; coding smoke expected under 45 seconds |
| Luna runner        | Launch exact approved command, return job receipt        | Explicit `gpt-5.6-luna`, low reasoning, minimal handoff context     |
| Node supervisor    | Own child, write logs, hourly health checks, detect exit | Zero AI tokens; no full-run completion deadline by default          |
| Terminal reporter  | One Luna summary attempt, then send evidence to parent   | At most 150 words requested; 60-second process deadline; no retries |

The reporter's word/time limits are not a hard token or dollar cap. Its CLI JSON log retains
usage evidence. Pipeline normalization/embedding/provider charges are separate from agent
orchestration charges. Full backlog imports are authorized without provider caps, unknown-cost
approval, completion estimates or an overall deadline. Retain usage telemetry for diagnosis.
Do not silently upgrade the cheap orchestration model.

The orchestrator and runner **end their turns** after setup. Do not keep an expensive turn alive
with sleep, wait/status loops, streamed logs, Goal mode, or hourly heartbeat automations.
An ordinary timer is sufficient: even hourly AI checks waste tokens when nothing needs a decision.
The pipeline still commits checkpoints and updates its heartbeat at its normal cadence.

## Handoff from the orchestrator

Read root and database AGENTS.md and the ingestion runbook first. Inspect maintenance/process
state once. Delegate explicitly to the configured `ingestion-runner` role or a native subagent
with `model: gpt-5.6-luna`, low reasoning, and no inherited conversation (`fork_turns: none` where
supported). Do not assume a subagent is cheap: unspecified models inherit the parent.

Supply a small, concrete handoff:

```text
Repository: /absolute/path/to/map
Parent task UUID: <actual current orchestrator task ID>
Task: launch only the following managed ingestion scope through ingest:supervise start.
Arguments after --: --resume <pinned-run-uuid> --unlimited
Completion deadline: none. Health checks: hourly ordinary code.
Callback: managed local Codex daemon and the parent task UUID.
Do not repair, retry, broaden scope, change model, or invoke another full run.
Return the launch receipt (or callback preflight failure) in <=150 words and end your turn.
```

The custom role lives in `.codex/agents/ingestion-runner.toml`. Its discovery is runtime dependent;
if the host does not expose custom roles, select the model explicitly in its native delegation
API. Plain ChatGPT conversations without filesystem/process/delegation tools cannot operate this
local worker. AGENTS.md is a workflow instruction, not a security boundary or scheduler.

## Commands

Run from the repository root. Substitute actual IDs; do not use a new unrelated task as the parent.
For Codex CLI environments, `CODEX_THREAD_ID` identifies the current task when provided.

```sh
# Verify the existing parent's connection without starting a model turn or ingestion.
pnpm --silent --filter @lib/db-map ingest:supervise probe --notify-thread "$CODEX_THREAD_ID"

# CHEAP RUNNER ONLY: resume the approved scope, detach, and return one launch receipt.
pnpm --silent --filter @lib/db-map ingest:supervise start \
  --notify-thread <parent-task-uuid> -- \
  --resume <run-uuid> --unlimited

# Expensive agent: small NEW cohort for development; smoke remains time-limited.
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  <source-file> --category campground --limit 1 --stop-after normalize \
  --max-llm-requests 1 --max-cost-usd 0.10

# On demand, not in an AI monitoring loop:
pnpm --silent --filter @lib/db-map ingest:supervise list
pnpm --silent --filter @lib/db-map ingest:supervise status --job <job-uuid>
pnpm --silent --filter @lib/db-map ingest:supervise stop --job <job-uuid>
pnpm --silent --filter @lib/db-map ingest:control list --json
```

`smoke` rejects resume (which preserves potentially huge cohorts), consolidation, duplicate
cohort flags, and limits outside 1–5. Its deadline is 1–60 seconds, followed by 10 seconds of
termination grace. Time spent establishing connections/collecting the final evidence is additional.
A row limit alone does not ensure short runtime. If a smoke test times out, inspect its evidence;
do not chain more smoke tests to drain the backlog. Stop-after means a partial run, not success.

Humans may use `start --local-only -- <run arguments>` to obtain detached process control and durable
results without an automatic agent callback. Unattended use requires the verified native scheduled reconciliation workflow below; other agents need a verified notification path.
For normal manual foreground operation, the existing `ingest:run` commands remain supported.

## Native Codex scheduled coordinator

All agents inspecting or managing ingestion begin with the project's
[job discovery and coordination procedure](../AGENTS.md#discover-and-coordinate-ingestion-jobs).
It maps UUID journals, execution logs and unresolved launch claims to the current database
evidence. Project ingestion records are independent of scheduled-run memory and global skills.
The native map task's saved Codex prompt owns its objectives and scheduled handoff; its
schedule, coordinator model and standing follow-up authorization live in Codex.
The ingestion controls belong to this project: `python3 scripts/coordinator-ingestion.py`.
The commands below retain their existing launch/admission requirements.

From the primary map checkout:

```sh
python3 scripts/coordinator-ingestion.py snapshot
python3 scripts/coordinator-ingestion.py accept --job ACTUAL_JOB_UUID
python3 scripts/coordinator-ingestion.py start -- data/poi/CAPTURE.json --category CATEGORY
python3 scripts/coordinator-ingestion.py start -- --resume ACTUAL_RUN_UUID --unlimited
python3 scripts/coordinator-ingestion.py stop --job ACTUAL_JOB_UUID
python3 scripts/coordinator-ingestion.py release --intent ACTUAL_INTENT_UUID --evidence PRIVATE_NOTE
```

The Python interface uses only the standard library and the login/injected shell
credentials. It reads variable names from .env.example references, never dotenv values.
Existing injected values win. DB_MAP_URL is required for database discovery; full provider
runs also require the existing pipeline keys. Values stay in the child environment.

`snapshot` joins current database controls with `.ingest-jobs/UUID/job.json` and
result.json evidence. Private admission observations and intent claims live in
`lib/db-map/.ingest-jobs/.coordinator/`, already ignored by Git. Two different native
scheduled owners can `accept` the same pinned job/run/execution to verify later-run
discovery; the existing verified receipt was retained during the helper relocation.
That receipt gates unattended starts, rather than any external model/schedule registry.

`start` records intent before invoking existing detached `ingest:supervise start
--local-only`, serializes coordinator launches and requires verified quiescence plus
resolved journals. It returns the exact job UUID and ends setup. Full runs/resumes use
--unlimited with no overall deadline and retain original cohort/stages/checkpoints.
Production imports use the primary checkout; a coding worktree cannot launch them.
Node owns the child group, sleep assertion, hourly probes and durable terminal result.
No Codex waiting process, terminal AI summary, immediate desktop callback or process-level
relaunch is promised. Ordinary scheduled passes reconcile completion at the cadence
selected in Codex. The app and host must be available for scheduled decisions.

Paul's continuous intended-capture/provider-stage spending authorization remains in
force. Only verified whole-file completion permits choosing the next eligible capture;
extraction, report suffixes or partial runs are not completion. Diagnose failed/stalled
work and global outages before resuming. Source-specific blockers may permit independent
captures. Maintenance/quiescence are required before changing running runtime/schema/data.

Reconcile human-started workers first; preserve healthy imports and avoid duplicate
sources. `stop` requests a targeted supervisor stop, which is not proof of termination.
`release` needs the exact terminal journal/result and database quiescence plus a verification
note. Database locks remain cross-host truth; a snapshot cannot serialize unrelated human
or unmanaged starts. PID presence does not identify a process or authorize a signal.

Lost/ambiguous start responses leave `imports/active.claim` held. Inspect the recorded
argv/time, newly created journals and database workers before any retry. An operator must
record the exact identified job_id in the matching intent before ordinary terminal release,
or prove submission absent before removing just that abandoned claim. Never expire a claim
by age, wipe the journal tree or kill a saved PID blindly. Raw logs and detailed evidence
remain private. The underlying ingest:supervise and ingest:control commands still provide
independent human/agent discovery and control.

## Notification setup and delivery limits

This Mac has the official standalone Codex installation at
`~/.codex/packages/standalone/current/codex`. Its managed local app-server daemon listens on a
user-only Unix socket. Remote control is disabled. The daemon is independent of browser extensions
and starts on demand during notification preflight. Inspect it with:

```sh
~/.codex/packages/standalone/current/codex app-server daemon version
~/.codex/packages/standalone/current/codex doctor --summary
```

The callback uses the supported `codex queue --remote unix:// --thread <uuid> --message <text>`
interface. Queueing adds one terminal message to the existing parent task; it does not override
that task's model, reasoning, sandbox or approvals. A running Codex client consumes the durable
queue for its loaded task. Keep the ChatGPT desktop app open; if it is closed or the task is not
loaded, the message remains queued until a compatible client loads that task. Browser ChatGPT
extensions are unrelated to this local route.

`ingest:supervise probe` starts/verifies the managed daemon without invoking a model or writing to
the task. It confirms transport readiness, but the supplied task UUID is authoritatively checked
only when the terminal message is queued. An invalid/deleted task produces a durable deferred
receipt rather than losing the result. The supervisor retries only an explicit queue rejection,
using ordinary code once an hour for up to 24 hours.

The Luna summary is attempted once after daemon preflight. Model failure falls back to structured
evidence. Accepted delivery is recorded; timeout, signal or spawn ambiguity is marked `uncertain`
and is **never retried automatically**, because the message might already be queued. Deferred
events may be explicitly retried with:

```sh
pnpm --silent --filter @lib/db-map ingest:supervise dispatch --job <job-uuid>
```

For `sending`, `uncertain`, or an abandoned `delivery.lock`, inspect the actual parent history before
repairing the receipt. A crash after submission cannot provide exactly-once notification. The parent
should recognize the stable `ingestion:<job-uuid>:terminal` event ID and avoid duplicate decisions.
The queue receipt is authoritative for durable acceptance, not proof that a loaded client consumed
it or that the resulting model turn completed.

## Evidence, stops, and recovery

Managed normalization handles bounded transient provider recovery inside the existing worker;
see [the runbook](poi-ingestion.md#transient-normalization-provider-recovery) for limits and evidence.
A live cooldown with a current heartbeat is expected. Leave it to ordinary code; do not wake
an agent, stop it merely for a 429, or launch a second worker. Smoke deadlines still win.
After a terminal `provider_recovery_exhausted` callback, inspect the exact attempt/status,
deduplicate the event ID, and report the exhausted bound. Do not cycle full resumes to work
around persistent provider failure. Diagnose availability/configuration before another launch.

Terminal evidence now includes normalization request count, recorded estimated cost and
unknown-cost count for the pinned execution, plus recovery state. For unrestricted work, the
suggested `resume` carries `--unlimited`; no spending or overall-deadline review is required.
Missing identity or completion evidence still needs diagnosis, while unknown cost remains
telemetry. Optional finite caps apply only to commands that explicitly select them.
A retry-policy-only change does not invalidate completed artifacts.
No provider retry allows the runner or supervisor to relaunch a terminated ingestion process.

Each job has a private ignored directory `lib/db-map/.ingest-jobs/<uuid>/`:

- `job.json`: immutable launch scope plus process IDs, host, pinned run/execution IDs and status.
- `worker.log`, `supervisor.log`: complete raw output, kept out of agent context.
- `result.json`: exit/signal, timeout/health reason, verified database outcome, recent attempts,
  bounded error tail, and exact managed resume command.
- `delivery.json`, `runner-summary.txt`, `runner-agent.jsonl`: notification receipt, compact summary,
  and reporter diagnostics/usage. Claim files prevent duplicate launch or paid summary attempts.

The worker sends run/execution identity over IPC instead of parsing console logs. Hourly probes
stop a child with stale heartbeat (>120 seconds at probe), terminal execution despite a live child,
missing identity, failed database probe, or no recorded progress for two hours. These conservative
stops require a new orchestrator decision; the supervisor never retries ingestion. Exit is detected
immediately, independently of hourly checks. Verified database success plus exit zero is required
for success; partial/budget/paused/error are distinct outcomes.

A stop requests graceful termination of the child process group created by this supervisor, then
forces it after grace. It never signals a saved PID. After force, use the runbook's process/lock
checks and reconciliation before resume. PID presence in `list` is only a hint, not identity proof.
Maintenance remains the admission authority; supervisor processes waiting to deliver notifications
are not ingestion writers. Their actual `run.ts` children are still discovered and registered.

The machine must remain awake and running. On macOS the worker holds a process-bound sleep
assertion during a non-dry-run import (see the [runbook](poi-ingestion.md#process-control-and-maintenance)).
Keep the lid open and a reliable connection; a detached process survives a terminal closing, but not
a host reboot, app sandbox cleanup, or supervisor SIGKILL. Local job files survive those events;
inspect them alongside `ingest:control list`, reconcile an absent execution, then delegate a new
supervised resume. Do not infer success from a finished process or trust a stale manifest. There is
no automatic OS-service restart or remote watchdog in this implementation. Never auto-relaunch an
abandoned worker claim. Preserve evidence before cleanup; local logs may contain source text/errors.

## Research basis (checked 2026-09-20)

- [OpenAI subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents): explicit per-agent
  models/reasoning and compact delegated context; defaults inherit the parent model.
- [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna): cost-sensitive model.
  API pricing is not a prediction of ChatGPT subscription credit consumption.
- [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md): scoped repository rules.
- [App-server protocol](https://learn.chatgpt.com/docs/app-server): thread state and terminal turn
  delivery; [noninteractive CLI](https://learn.chatgpt.com/docs/non-interactive-mode) for one-shot summaries.
- [Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app): model choice and local-host
  availability constraints. No recurring AI task is needed for healthy process monitoring here.

Run `pnpm --filter @lib/db-map ingest:test-supervisor` for local process/transport tests. Those tests
use ordinary Node children and mocked notifications, with no provider calls or parent wake-ups.

The explicit integration check is `pnpm --filter @lib/db-map ingest:test-supervisor:integration`.
Delegate it to the cheap runner. It requires admission open and quiescence, uses one non-POI record
and zero provider budgets, exercises smoke plus detached resume, and cleans its fixture data.
It deliberately uses local-only delivery so tests never wake another agent.
