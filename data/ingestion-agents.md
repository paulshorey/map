# Economical agent operation of ingestion

The expensive orchestrator decides scope and repairs failures. A GPT-5.6 Luna runner launches
that exact scope. A detached Node process owns the ingestion worker, waits for exit, and checks
its database heartbeat/progress once an hour. **No model is invoked for healthy monitoring.**
On termination, a compact evidence packet can wake the original orchestrator through a verified
Codex app-server connection. The existing database checkpoints remain the source of resume truth.

## Roles and cost boundaries

| Role               | Work                                                     | Bound                                                               |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Smart orchestrator | Inspect, decide, develop, repair, delegate               | Never execute full ingestion; smoke tests expected under 45 seconds |
| Luna runner        | Launch exact approved command, return job receipt        | Explicit `gpt-5.6-luna`, low reasoning, minimal handoff context     |
| Node supervisor    | Own child, write logs, hourly health checks, detect exit | Zero AI tokens; 48-hour default deadline, configurable 1–168 hours  |
| Terminal reporter  | One Luna summary attempt, then send evidence to parent   | At most 150 words requested; 60-second process deadline; no retries |

The reporter's word/time limits are not a hard token or dollar cap. Its CLI JSON log retains
usage evidence. Pipeline normalization/embedding/provider charges are separate from agent
orchestration charges; set pipeline budgets explicitly. Do not silently upgrade the cheap model.

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
Arguments after --: --resume <pinned-run-uuid> --max-llm-requests <budget> --max-cost-usd <budget>
Deadline: 48 hours. Health checks: hourly ordinary code.
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
  --notify-thread <parent-task-uuid> --max-hours 48 -- \
  --resume <run-uuid> --max-llm-requests <budget> --max-cost-usd <budget>

# Expensive agent: small NEW cohort, only when expected to finish within the deadline.
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
results without an automatic agent callback. This mode is **not** an unattended agent workflow.
For normal manual foreground operation, the existing `ingest:run` commands remain supported.

## Native OpenClaw runner

The local OpenClaw coordinator can own the cheap-runner role directly. Its configuration and
launcher live in `/Users/pshorey/git/openclaw`; read that checkout's coordinator procedure.
Use `ingest:supervise watch`, which stays in the foreground, prints one launch receipt and one
terminal JSON event, writes the same durable job/result/log files, and never starts a model or
Codex callback. OpenClaw's background exec owns this foreground command. Node owns hourly
health checks and the 1–168-hour deadline. The local OpenClaw wrapper delivers a compact
terminal result to the exact owning dashboard conversation through supported targeted
`system event --session-key OWNER --mode now`, after the supervisor saves durable evidence.
Its generic payload begins `INTERNAL_MAP_TERMINAL_EVENT`, identifies the local wrapper and
carries the exact stable event ID. The owning prompt handles this marker before heartbeat
launch logic. Native exec ownership remains intact; waiting makes no model calls.
OpenClaw 2026.9.5 can defer ordinary native exec-exit events until the next hourly heartbeat
and hide structured `Exec completed (...)` details after delivery resets to `none`. Spawned
heartbeat sessions also intentionally reject CLI chat sends. Use the supported generic
completion path; never strip subagent restrictions or patch session storage. Test automatic
preflight-to-import-to-terminal continuation, not just a single wake after manual input.
See [the local wrapper's procedure](/Users/pshorey/git/openclaw/README.md) for its ownership,
completion receipt, preflight and delivery checks.

1. Refresh inventory after checkout/file changes; read `ingest:queue --json` and control state.
   The queue is a recommendation, not admission or evidence that an outage was repaired.
2. Review unclassified files before setting category/disposition. Resolve supporting files,
   alternate exports, empty captures, wrapper keys, event editions and campsite-versus-facility
   granularity. See [capture folder guidance](poi/README.md). No progress state belongs in Git.
3. Verify the `process` tool and notification configuration, then exercise the wrapper's
   harmless terminal-callback preflight in the actual owning internal dashboard conversation.
   Confirm an automatic continuation after the initiating turn ends, with the correct owner,
   event ID and saved terminal evidence; record the verified integration receipt. Repeat after
   a Gateway restart or notification configuration change. Config availability, a queued native
   event or a manually forced follow-up alone does not prove delivery. Missing completion is a
   blocker, not permission to use local-only or run a model polling loop.
4. Record the exact file/category or resume UUID, budgets, overall deadline and native process
   handle in OpenClaw's private ledger. Launch one source using its `scripts/run-map-import.sh`
   in native `exec` with `background=true` and `timeoutSeconds=0` (Node enforces the deadline).
   Do not use `nohup`, shell `&`, or a Codex implementation wrapper. End the agent turn.
5. Reconcile terminal events by stable `event_id`, job/result file, pinned run/execution and
   database inventory. Only `succeeded` plus `verified_at`, inventory `coverage="complete"`
   and queue `action="complete"` for the exact file permit advancing. Raw
   `ingestion_files.status="complete"` and `extraction_complete=true` prove extraction,
   not downstream completion. Samples, suffix verification, exclusions and quality remain separate.
   The delayed native exit event may arrive after the terminal callback; deduplicate it using
   the same saved job/event evidence rather than treating it as another import. An unconfirmed
   callback leaves the durable result for reconciliation and blocks automatic queue advancement.
6. On failure, stop that file's automatic retries, preserve evidence, and delegate a precise
   repair through OpenClaw's connected Codex CLI wrapper. Codex handles maintenance and bounded
   smoke validation. Other files may proceed only after the engineer confirms a source-specific
   blocker; budget/outage/schema/global-lineage blockers stop provider work across the queue.

`watch` requires `--max-llm-requests`, `--max-cost-usd` and `--geocode-limit`. Consolidation is
excluded. A resume retains a potentially large original cohort. Subtract prior usage and
diagnostics from the original allowance: `ingest:status --json` includes
`executions[].normalization_usage`, including failures and unknown costs. Supervisor results
carry pinned usage and a budget-subtracted resume. Unknown costs require review. Normalization
thresholds do not cap embedding/matching/fusion bills; record separate provider authorization.
Never reset an exhausted allowance by starting another file or invocation.

Native handles live in Gateway memory and are lost on restart. Recover using PostgreSQL,
local job files and verified process/lock evidence, never by replaying a launch command.
The machine must remain awake. The queue does not auto-retry or drain files by itself.

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
unknown-cost count for the pinned execution, plus recovery state. The suggested `resume`
preserves the remaining normalization limits. Subtract any subsequent smoke/repair spending
from the same approved task budget too. Missing evidence or unknown cost requires review;
never interpret it as zero. A retry-policy-only change does not invalidate completed artifacts.
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

The machine must remain awake and running. A detached process survives a terminal closing, but not
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
