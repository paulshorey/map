# POI ingestion: operation and recovery

For agent-operated long runs, use [economical agent operations](ingestion-agents.md): explicit
cheap-runner delegation, hourly model-free supervision, terminal reporting, and bounded smoke tests.
The process-control and maintenance rules in this runbook still apply.

This is the shared reference for humans and agents. [README](../README.md#poi-ingestion)
owns human setup and full-run commands. [AGENTS.md](../AGENTS.md) owns agent execution
budgets and working rules. The [database guide](../lib/db-map/AGENTS.md) maps implementation
files. Keep pipeline facts here rather than copying them into both entry points.

## Operating model

Humans usually launch long imports manually. Agents own development, debugging and operation
of **every stage**, including stopping human-started workers, migrations and experimental data
repairs. Small fixed selections remain the default for debugging; full execution is appropriate
when the requested task requires it. Both use the same managed `ingest:run` and `ingest:control`
interfaces. Stop and confirm quiescence before runtime/schema changes.
All examples run from the repository root; replace angle-bracket placeholders.

```text
file → extract → fixed record cohort → normalize → geocode → embed → match → canonical check
                                                                           ↓
                                              optional global consolidation → report → verify
```

Canonical builds happen transactionally inside matching/merging and normalization refresh;
`canonical` checks their existence. It is not a separate rebuild algorithm. Extraction finishes
and freezes the cohort before the record scheduler starts. Independent records then progress
through their own dependencies; ready downstream work has priority. Shared Fireworks admission
defaults to four requests in flight (`--llm-concurrency 1..16`), across normalization, matching
and fusion. The selected normalization model, prompt and thinking mode are unchanged: every
eligible POI still uses the LLM. Explicit `--no-llm` remains a diagnostic option.

Run **one full import process at a time**, queuing additional files. Record concurrency and
provider admission operate inside that process. `canonicalLane` is a process-local semaphore;
the matcher separately uses a database-wide, fail-fast advisory lock. Two full workers with
different source locks can therefore both extract/normalize, then collide at matching with
`Another ingest:match process is already running.` This is a coordination failure, not evidence
of a provider outage or a pool checkout timeout. Preserve both cohorts/artifacts and diagnose
before resuming. Queue the next file until the first run is verified and its process/locks exit.
Cross-process waiting/serialization would require a separate stop-aware implementation and
multi-process validation; removing the matching guard is unsafe.

Recognized record validation failures are quarantined with durable issues; independent records
continue and the run ends partial. Ten consecutive validation failures in one stage trip a
systemic circuit breaker. Authentication, billing, unexpected provider shapes, database, schema,
source-lock and lineage faults stop globally. Non-POIs are explicitly skipped downstream.
All canonical mutations use one process lane and the existing database-wide canonical lock.
Linked embedding/geocode activation refreshes canonical build inputs in that same transaction;
unlinked records activate independently.
Geocoding stays at one request per second. Embeddings batch up to 32 records, with a two-second
maximum collection wait and one embedding request in flight. At 1,000 normalized records waiting
for downstream verification, normalization pauses until the backlog drops below 500.

Scheduler idleness requires a stable dependency pass: if work finishes during a claim query,
the scheduler scans dependencies again before exiting. Before report/global verification it
also checks that every selected task outside quarantined or operator-excluded records has
finished. Remaining work with no active/ready tasks stops with `scheduler_stalled`, including
stage/state counts for diagnosis; it never establishes completion. Limited stop points and
provider-budget pauses retain their normal incomplete outcomes.

Database failures retain structured `error.database` evidence: checkout versus query operation,
pool capacity, total/idle/waiting clients and up to 20 oldest connection holders with stage,
record/attempt identity and hold duration. The managed source-lock connection is labeled.
No SQL, parameters or credentials are retained. A local pool checkout timeout has code
`database_pool_checkout_timeout`; it stops globally and does not enter provider cooldown or
automatic query replay. A pending provider request aborted by a systemic failure preserves
that original error. See the [pool API](https://node-postgres.com/apis/pool) and
[Node abort semantics](https://nodejs.org/api/globals.html#abortsignalreason) for the client behavior.

Terminal packets include structured `execution_error` and recent attempt errors. Their
`current_stage` is the earliest unfinished cohort stage, which may differ from the last failed
record attempt. Use both when locating the failure. A historical connection timeout without
pool evidence does not prove a leak or an infrastructure outage; check current admission and
database availability, then validate the pinned affected record before deciding to resume.

Three distinct questions need distinct evidence:

1. **What happened in this invocation?** Execution and attempt history, provider requests,
   timestamps, errors, and local journal.
2. **Did this selected run finish?** All requested stages completed, report and global lineage
   verification and selected-record output checks passed, and the run has `status=succeeded` with `verified_at`.
3. **Is the category complete?** Every expected source/file is accounted for, intended records
   reached acceptable outputs, exclusions are reviewed, and quality checks pass. A successful
   sample or zero match-ready rows does not answer this question.

## Durable state

| Object                                                       | Meaning                                                                                                                                          |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `research_ingest_runs`                                       | Logical task: source, category, file version/hash, options, pipeline versions, current stage, stop reason, verification time.                    |
| `research_ingest_executions`                                 | One process invocation of a run: host, PID, options, start/finish, five-second heartbeat, outcome and error. A resume creates another execution. |
| `research_ingest_control` / `research_ingest_control_events` | Persistent maintenance gate, ownership token/reason, and append-only operator actions.                                                           |
| `research_ingest_run_items`                                  | Fixed source-record IDs and observation IDs selected after extraction; resume never expands a sample.                                            |
| `research_ingest_attempts`                                   | One attempt at a stage/target: execution, input IDs, output IDs, timing, structured error. Retries append rows; old errors remain.               |
| `research_ingest_run_records`                                | Extraction ordinals, identities, payload hashes and outcomes. The original file is the replayable extraction input.                              |
| `research_normalization_requests`                            | Provider request/response, tokens, cost and latency, linked to exact run and attempt for managed work.                                           |
| `research_pipeline_jobs`                                     | Older mutable normalization job state. Useful diagnostic evidence, but not the execution history or managed resume authority.                    |

Attempts are inserted as `running` before work. They finish as `succeeded`, `reused`,
`skipped`, `failed`, `blocked`, `waiting_budget`, or `paused`. When a replacement worker
owns the source lock, unfinished attempts of the resumed run become `interrupted` and retries
append new attempts. Completed record attempts are skipped on resume while their outputs remain valid; missing or changed downstream outputs are checked again, then recomputed where supported or reported as blocked. Report/verify rerun.
The JSON output from an attempt identifies its normalization, geocode, embedding, canonical,
or build artifact where applicable. Location enrichment binds an artifact to the exact normalized source point, including when no provider call is needed.

Normalization activation persists the deterministic coordinate result, including clearing
invalid `(0,0)` or out-of-range pairs and applying detected swaps or URL coordinates.
A geocode is retained only for the same normalization artifact with a valid coordinate pair
and a matching geocode artifact. A changed point retires the old membership before matching
again. Exact normalization-cache reuse checks this projection too: a mismatched projection
reactivates the saved normalization without another LLM call. This repairs activation rather
than changing the immutable model-output contract or invalidating all older normalizations.

`research_pois` holds current projections and active artifact pointers. Immutable observations,
normalizations, geocodes and embeddings preserve provenance. Active
`research_canonical_memberships` are authoritative; `canonical_poi_id` is a lookup cache.
`canonical_poi_builds` / `canonical_poi_build_inputs` show how map output was built.
`research_match_decisions`, overrides, consolidation memos and redirects preserve match history.

## Command scope and limits

File paths resolve from the repository root and must be under `data/poi/`. Categories must
exist in the code-owned taxonomy and are explicit on new runs. Known files use the source
registry; other flat JSON/JSONL/CSV files use a derived source slug and generic extractor.
Inspect the printed source. Wrapper/nested formats need extractor configuration. See the
[capture spec](poi-research/capture-spec.md) before adding sources.

| Control                                    | Behavior                                                                                                                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--limit N`                                | Positive integer; caps extraction selection and freezes at most N records for every record stage. Not a time limit; hashing/parsing can still scan a large file.                                                                                 |
| `--record ID`                              | Exact **source record ID**, not research UUID; defaults to a one-record limit. Useful for a failure late in a file.                                                                                                                              |
| `--stop-after STAGE`                       | Pause after extract, normalize, geocode, embed, match, canonical, consolidate, or report. Verify is the final stage. Exit code 2 indicates deliberate incomplete work.                                                                           |
| `--resume UUID`                            | Same managed run/cohort; new execution. Preserves original options; clears the old stop point. Only a new stop point, dry-run, `--unlimited`, and optional provider limits may be supplied.                                                      |
| `--from STAGE`                             | New run starting record-stage processing at that stage; extraction and scope selection still happen. Skipped prerequisites must already exist. Prefer resume for failures.                                                                       |
| `--dry-run`                                | Resolve/hash file and print effective options, without writes/provider calls. Does not parse/validate all rows or simulate the pipeline.                                                                                                         |
| `--reprocess normalize`                    | New run with a stable run-specific normalization generation; recomputes once, then resumes using that generation's cached result.                                                                                                                |
| `--reprocess extract` / `all`              | Replay extraction; `all` also forces normalization. Other forced stage values are rejected. Downstream work follows invalidation/readiness, not a blanket reset.                                                                                 |
| `--retry-failed`                           | Freeze records currently in failed/stale normalization state. It is a new repair selection, not a substitute for resuming the failed run.                                                                                                        |
| `--shadow`                                 | Evaluate normalization without activating its output; pause after normalization. Original shadow option persists on resume.                                                                                                                      |
| `--no-llm`                                 | Deterministic normalization, matching and descriptions. Does not disable geocoder or embedding calls. Degraded output does not validate the LLM path.                                                                                            |
| `--max-llm-requests N`, `--max-cost-usd N` | Normalization budgets per execution, checked between records. Cached/deterministic results remain usable at zero budget. Repair/fallback within a record may exceed the threshold. Not a hard monetary cap and not a budget for matching/fusion. |
| `--unlimited`                              | Removes request, cost and geocoder caps, including inherited caps on a resume. Cannot be combined with finite provider limits. Does not change the pinned file/record cohort.                                                                    |
| `--geocode-limit N`                        | Optional geocoder-call cap per managed execution; cache hits do not consume it. Managed runs have no default cap. Standalone `ingest:geocode` retains its 4500-call default. No shared daily-quota enforcement.                                  |
| `--consolidate`                            | Explicit global canonical sweep, with audited pair adjudications and merge groups. Incompatible with limited/record runs. Usually a manually launched long job; agents may operate it when required by the task.                                 |

A paused/blocked/budget-limited run exits 2 (pnpm prints its nonzero-exit banner); failure
exits 1; successful verified work exits 0. An empty selection is `partial`, not success.
A run beginning with `--from` only certifies its requested suffix and the integrity checks,
not that it regenerated all upstream data. A `--no-llm` success can contain degraded output.

## Continuing efficiently

`ingest:run <file> --category <category>` creates a **new logical run**. To continue interrupted
work, use the exact UUID printed by that process:

```bash
pnpm --filter @lib/db-map ingest:run --resume <uuid>
```

Resume preserves the original cohort, options and successful checkpoints. For a capture moved
within the repository, it reads the current path from that run's source-file identity while
retaining the originally submitted path in historical run options. A path-only move must
reconcile the inventory and source-file identities before resume; a new file path alone starts
a separate file history. Resume selects unfinished stage items in PostgreSQL instead of
visiting each completed item in application code. This is
per-record completion, not a highest-ID cursor: earlier failed or invalidated items remain eligible
when later items have already completed. Source IDs need not be numeric or sequential.

New runs reuse existing normalization caches through the normalizer's exact identity checks.
Resumes adopt valid normalization attempts only when their observation and active artifact IDs
still match. `research_ingest_tasks` holds record/stage dependencies, claims and outcomes.
Claims use `FOR UPDATE SKIP LOCKED`; activation checks the claim token, execution and observation
inside the same transaction as artifact, attempt and task writes. Abandoned tasks can be reclaimed
after the predecessor has stopped. Successful artifacts survive a stopped invocation; external
provider delivery is at least once, so a lost response can still be billed again.

Record verification certifies the exact observation, normalization, coordinates, embedding,
membership and canonical build. File completion additionally requires a successful full-cohort
global verification at least as recent as the active artifacts and record proofs. A later sample
cannot hide a compatible full-file continuation or certify an entire file. Shadow normalization
never activates its output. Optional finite normalization budgets serialize admission to preserve
threshold behavior; full imports and resumes use `--unlimited` and have no mandatory deadline.

### Shared agent and human observability

`ingest:overview --json` and loopback `GET /api/overview` consume the same versioned assessment.
The CLI works without the dashboard. Database evidence is read in one repeatable-read, read-only
transaction; local job/intent/process evidence has its own observation time. Unknown evidence
blocks launch recommendations. Missing components never become an empty healthy summary.

```sh
pnpm --silent --filter @lib/db-map ingest:overview --json
pnpm --silent --filter @lib/db-map ingest:overview --run <run-uuid> --detail --json
pnpm --silent --filter @lib/db-map ingest:overview --file <logical-path> --json
pnpm --silent --filter @lib/db-map ingest:overview --limit 100 --offset 100 --json
pnpm --silent --filter @lib/db-map ingest:doctor --run <run-uuid> --json
pnpm --silent --filter @lib/db-map ingest:issues list --run <run-uuid> --json
```

The default returns 20 files, whole-inventory totals, stage task counts, exact worker/run/job
identity, interventions, next action, last commits, exact active record IDs and active ages, scan receipts, and measured
performance suggestions. Metrics are bounded to the latest 1,000 calls/completed attempts.
Provider calls include admission wait, response latency, requests, batch size, known/unknown cost,
model, prompt/cache/completion/reasoning tokens when supplied, HTTP status and quota headers.
Attempt timing separates provider, database round trips and remaining local work. Batch calls
are attributed to all participating attempts without counting one call repeatedly. No credentials,
raw provider payloads or SQL parameters are included. Legacy normalization telemetry is labeled
separately. Measured findings and optimization hypotheses have different confidence labels.

The payload's TypeScript contract and JSON Schema live in `lib/db-map/contracts/ingestion-*`.
API filters are `run`, `file`, `limit`, `offset`, `detail=1`; `inventory=1` includes the original
inventory projection so the dashboard can refresh both panels with one database snapshot.
Detail/doctor also returns five pending/paused/quarantined/budget-held task samples per stage/state.
Focused status/control/trace and coordinator snapshot interfaces remain the drill-down tools.
Hourly Node checks persist committed progress separately from latest attempted work and task counts
in each job journal; they do not invoke a model for healthy progress.

`research_ingest_inventory_scans` records checkout, commit, stable host ID, scan start/end,
outcome and errors. Its exclusive advisory key `(91832,3)` is distinct from the shared worker /
exclusive maintenance key `(91832,1)` and admission mutex `(91832,2)`. New workers and jobs also
record a persistent installation UUID plus process start time. Legacy hostname reconciliation
remains conservative. A stored PID alone never authorizes signaling.

`data/poi-research/expected-captures.json` accounts for the audited 247 captures, required imports,
supporting captures and explicit review/exclusion reasons. It holds expectations, not progress.
Structural completion, degraded output, sampled quality acceptance and category completeness
are separate. No quality acceptance is inferred from an exit code or a few valid coordinates.

After inspecting an issue, repairs require quiescent owned maintenance. Retry clears the affected
stage and descendants while retaining attempts and earlier successful artifacts. Explicit exclusion
retires the record/membership, rebuilds affected canonical output and records the operator reason;
no automatic exclusion is performed. Quality review is an auditable statement about inspected
current-capture sample records, not proof that an entire category is complete.

```sh
pnpm --silent --filter @lib/db-map ingest:issues resolve --issue <issue-uuid> \
  --maintenance-token <owned-token> --action retry --reason '<diagnosis and repair>' --json
pnpm --silent --filter @lib/db-map ingest:issues resolve --issue <issue-uuid> \
  --maintenance-token <owned-token> --action exclude --reason '<reviewed exclusion>' --json
pnpm --silent --filter @lib/db-map ingest:quality review --file <logical-path> \
  --decision accepted --records <source-id,source-id> --reason '<sample evidence>' --json
```

## Bounded stage diagnostics

```bash
# Choose the failing record directly; validate normalization with a small provider budget.
pnpm --filter @lib/db-map ingest:run <file> --category <category> --record <id> --stop-after normalize --max-llm-requests 3 --max-cost-usd 0.05

# Continue the SAME record through geocoding/embedding, then matching and verification.
pnpm --filter @lib/db-map ingest:run --resume <uuid> --stop-after embed
pnpm --filter @lib/db-map ingest:run --resume <uuid>

# A deterministic sample; embedding/geocoding can still call providers if continued.
pnpm --filter @lib/db-map ingest:run <file> --category <category> --limit 3 --no-llm --stop-after normalize

# Validate a normalizer change against an exact record without activating the result.
pnpm --filter @lib/db-map ingest:run <file> --category <category> --record <id> --reprocess normalize --shadow
```

Resuming a sample does not drain the remaining source. After validation, the operator starts a
new full file run. Do not loop small batches as a disguised full background import.

## Investigating the latest attempted run

```bash
pnpm --filter @lib/db-map ingest:status
pnpm --filter @lib/db-map ingest:status --source <source> --category <category>
pnpm --filter @lib/db-map ingest:status --run <uuid> --json --limit 10
pnpm --filter @lib/db-map ingest:trace --source <source> --record <id>
pnpm --filter @lib/db-map ingest:trace --canonical <uuid>
```

`latest` orders by the latest execution start (including resuming an older run), falling back
to run creation for legacy records. Pin the returned UUID before investigating further.
The compact view shows scope, execution identity, stage outcomes, recent work, unresolved
attempts, stop reason and resume command. JSON adds exact input/output IDs, errors and source
state/artifact samples. Samples are capped at 1–20 per section, not a full history export.
Queries use a consistent read-only snapshot and timeouts.

1. Inspect the latest execution and unresolved attempt. Distinguish **started work** from
   **committed results**. A stale heartbeat (over 30 seconds) is suspicion, not proof of death.
2. Read the error, input IDs, output IDs and prior attempts for that target. Trace its raw
   observation, provider response, active artifacts, membership and canonical build.
3. Fix the earliest broken stage. A schema/evidence rejection differs from a provider outage,
   a remembered geocode miss, or an intentional budget/stop limit.
4. Resume the pinned UUID. The worker acquires its source lock before recovering unfinished
   attempts; it refuses if another managed worker owns the source. File hash, extractor and
   pipeline version changes require a new run. Replaced/deleted pinned observations or changed
   active normalization output also refuse resume rather than silently mixing data.
5. Recheck status, trace representative output, and report category coverage separately.

For full history or exact recent writes, connect using the existing `DB_MAP_URL` environment
variable (never print credentials). For example, in psql set `run_id` to the chosen UUID:

```sql
-- Most recently attempted/finished units, including prior failed retries.
SELECT id, execution_id, stage, target_key, status, started_at, finished_at,
       input, output, error
FROM research_ingest_attempts
WHERE run_id = :'run_id'::uuid
ORDER BY greatest(started_at, finished_at) DESC, id DESC
LIMIT 30;

-- Provider evidence attributable to this run, not merely the same source/time window.
SELECT q.* FROM research_normalization_requests q
WHERE q.run_id = :'run_id'::uuid
ORDER BY q.created_at DESC LIMIT 10;

-- Cohort with current output pointers: current state may be newer than the run's artifacts.
SELECT i.source_record_id, i.observation_id, rp.normalization_state,
       rp.active_normalization_id, rp.active_geocode_id, rp.active_embedding_id,
       rp.canonical_poi_id
FROM research_ingest_run_items i
LEFT JOIN research_pois rp ON rp.id=i.research_poi_id
WHERE i.run_id = :'run_id'::uuid ORDER BY i.source_ordinal;
```

`first_seen_at` means insertion and `last_seen_at` means source observation, not a general
update time. Use stage artifacts and attempt output IDs for downstream write evidence.
Source-wide sections of status/report include other runs; they do not prove run attribution.

## Process control and maintenance

Use the same typed CLI from terminals, agents and automation. JSON output is the machine
interface; operator actions are recorded in `research_ingest_control_events`.

```bash
# Discover recorded workers, host/PIDs, source locks and local script candidates.
pnpm --filter @lib/db-map ingest:control list --json

# Gracefully stop one run or all currently recorded managed runs, and wait for evidence.
pnpm --filter @lib/db-map ingest:control stop --run <run-uuid> --wait-seconds 30
pnpm --filter @lib/db-map ingest:control stop --all --wait-seconds 30

# BEFORE changing ingestion runtime code, profiles, in-use inputs, schema or shared data:
pnpm --filter @lib/db-map ingest:control maintenance enter --reason 'Describe the change' --wait-seconds 30
pnpm --filter @lib/db-map ingest:control list --json
# Proceed only when quiescent=true; retain the printed maintenance token.

# Optional: repair an abandoned LOCAL execution label after proving absence and released locks.
pnpm --filter @lib/db-map ingest:control reconcile --execution <execution-uuid>

# After edits/static checks, reopen admission for bounded validation or an intended resume.
pnpm --filter @lib/db-map ingest:control maintenance exit --token <maintenance-token>
pnpm --filter @lib/db-map ingest:run --resume <run-uuid>
```

Maintenance is persistent, database-wide, and independent of the operator process. It rejects
new managed workers, requests existing workers to pause, and is also checked on heartbeats.
Admission and gate changes share a transaction mutex; each admitted worker holds a shared
lifetime lock even before creating its run. This closes the startup/discovery race. A source
session lock still excludes overlapping work for that source. Exit requires the current gate's
token, preventing accidental replacement of another operator's maintenance session. Tokens are
coordination identifiers, not secrets or authentication. Inspect owner/reason before reopening.

Entering maintenance or stopping exits 0 only when the requested stop is confirmed; exit 2 means
not confirmed within the wait budget (0–60 seconds). The gate and stop requests remain active on
timeout; never start editing just because a pause was requested. Inspect again with `list`,
allow the current provider request to finish, or investigate a stuck worker. The old `ingest:pause`
command and dashboard pause button only request a pause; they do not wait for process exit.
Stopping all is a snapshot operation; maintenance additionally prevents new admission.

Evidence is deliberately separate: stored `running`, stale heartbeat, source locks, admitted
workers and local PID presence can disagree. A local PID may have been reused, so the CLI never
signals a process just because its PID matches a database row. For necessary targeted termination,
verify host, PID, command and process start time with host tools first; use SIGTERM before forced
termination. Never kill all Node/pnpm processes. Reconcile only accepts an absent local worker
while maintenance is enabled and locks are released; it preserves errors and marks unfinished
attempts interrupted without claiming to know why the worker exited. Remote/unknown PIDs require
host inspection; no forced termination or remote process supervision is hidden in this CLI.
Host identity checks accept case differences and a single `.local` mDNS suffix on the same short
name, including a trailing DNS dot. Other fully qualified names must match in full; a shared
first label alone is insufficient evidence that a remote host is local. PID presence still does
not establish process identity or authorize a signal.

Managed admission covers connected hosts using the updated runtime. Local `ps` discovery also
flags standalone ingestion/import scripts conservatively, but cannot discover arbitrary wrappers,
other checkouts or remote standalone writers reliably. Stop those explicitly on their host; a
maintenance flag cannot fence old code that does not honor it. Prefer managed orchestration for
writable work. Read-only diagnostics remain available during maintenance. Dashboard inventory
shows the gate's reason; lifecycle commands run in the terminal, without a web shell endpoint.

On macOS, a non-dry-run managed worker holds `caffeinate -i -s -w <worker PID>` while it runs.
This prevents idle sleep and, on AC power, system sleep that could drop its PostgreSQL session
and source advisory lock. The guard has its own process group so supervisor SIGTERM or
terminal SIGINT leaves the assertion active while the worker finishes its current record.
Normal cleanup stops the guard; `-w` releases it after abrupt worker death. Battery power, lid closure,
explicit sleep, and network/database outages can still interrupt a connection. If the lock
client errors, the worker journals the PostgreSQL error and exits immediately; it never
continues writing without the session lock. Inspect the worker log and local journal, confirm
process/lock quiescence, then resume the pinned run rather than starting a new cohort.

For implementation changes, keep maintenance on through edits, migrations and static checks.
Reopen for bounded integration/provider validation only after code is ready; re-enter before
further edits if validation fails. Resume old runs only when stored file/pipeline versions and
artifact semantics remain compatible. A performance/control-only change need not discard the
cohort; input/prompt/schema changes may require version bumps and a new run. Do not automatically
restart all previously running jobs. Report final gate state and which runs remain paused.

## Pausing and crash recovery

### Fireworks GLM configuration

The shared LLM client defaults to Fireworks serverless
`accounts/fireworks/models/glm-5p3-flash` at
`https://api.fireworks.ai/inference/v1`, using shell-injected `FIREWORKS_API_KEY`.
This covers normalization, prose dates, match adjudication, and description fusion.
There is no separate thinking model ID. Remove stale DeepInfra `LLM_PROVIDER`,
`LLM_MODEL`, and `LLM_BASE_URL` overrides when switching; the client rejects an
inconsistent provider/endpoint before accessing a key or sending a request.
See [.env.example](../.env.example) for the non-secret configuration catalog.

`LLM_THINKING_BUDGET_TOKENS` defaults to 256 for GLM and must be a positive integer.
The client sends the integer as `reasoning_effort`; GLM 5.3 is a thinking-only
model and rejects disabling thinking. It never also sends `thinking`, because
Fireworks rejects both controls together. Each call adds this allowance to its
final-answer allowance to form total `max_tokens`: normalization uses 1800 + 256
= 2056; short date answers use 64 + 256 = 320. The cap leaves room for a final
answer but does not guarantee valid or complete JSON. An explicit
`accounts/fireworks/models/deepseek-v4p1-flash` override defaults to 2048 and
requires at least 1024 for a hard cap; smaller V4.1 values do not enforce a cap.
See the [chat API](https://docs.fireworks.ai/api-reference/post-chatcompletions).

Only final `message.content` is parsed/stored; separate reasoning content is not
added to JSON or retained in the request journal. The supported OpenAI-style
`json_schema` wrapper is retained; see [structured outputs](https://docs.fireworks.ai/structured-responses/structured-response-formatting).
A JSON-object fallback only follows an explicit unsupported-format 400/422,
not authentication, credit, thinking configuration, or invalid-schema errors.
A `length` finish reason stops without repeating the same inadequate token cap;
the failed request retains any returned usage/cost. Review the output/thinking
allowance before resuming instead of treating truncation as a provider outage.

`LLM_SERVICE_TIER` defaults to `priority`, sent as `service_tier: "priority"` on
all shared Fireworks chat calls. Set it to `default` to explicitly select Standard;
other values fail configuration validation. A rejected Priority request never silently
downgrades. [Priority admission](https://docs.fireworks.ai/serverless/serverless-modes)
reduces load shedding during congestion; it shares rate limits with Standard and does
not guarantee recovery from an infrastructure outage or faster generation. Keep existing
token caps, structured output and bounded recovery regardless of tier.

The fallback estimate uses [serverless prices](https://docs.fireworks.ai/serverless/pricing),
checked 2026-10-14: GLM Standard costs $0.15 input, $0.03 cached input, and $0.50
output per million tokens; Priority costs $0.1875 / $0.0375 / $0.625. An explicit
DeepSeek V4.1 override retains its own $0.30 / $0.006 / $1.20 Standard rates; Priority
is also 1.25 times those rates. Completion tokens include thinking and are counted once.
Provider-reported cost takes precedence, including zero. Fallback pricing uses the
response's `service_tier` when supplied, otherwise the requested tier; it remains an
estimate. Unknown models/served tiers or missing/malformed usage remain unknown cost.
Managed provider-call `concurrency` metadata records `service_tier_requested` and
`service_tier_returned`; the latter is null when the response omits it, so requesting
Priority is not reported as proof of the tier actually served. Per-record repair,
fallback, lost-response and non-normalization spending retain the limits in the budget
table above.

Captured primitive attributes are authoritative in the resolver even if the
model omits or contradicts them. Zero and false survive. Known rating, review-count,
price, vehicle-length/site-count and campground boolean strings are typed by code;
hookup amperage, big-rig/pull-through/back-in flags are included. Opaque IDs and other text
remain intact. Each retained captured attribute receives its exact source path.
Additional model attributes need an exact primitive value at a cited input path;
the evidence field must identify that attribute key (`attributes.<key>` or the key itself).
Generic `attributes` evidence cannot donate a matching scalar to an unrelated extra.
container-only, missing or contradictory evidence cannot activate an invented value.
Discarded extras retain `attribute_dropped_*` diagnostics without degrading an otherwise
valid record. Unsupported core fields still degrade it; source conflicts retain the captured value.
Nested captured data remains in immutable raw observations and may support such
additional scalar attributes. Malformed attribute/evidence arrays fail validation
and use the existing bounded JSON repair path.

Unusable normalization output (invalid JSON/schema, empty final answer or truncation) gets
one contextual repair; truncated/empty output uses a bounded larger final-answer allowance.
If a provider rejected `json_schema`, the separately audited `json_object` compatibility fallback
also remains the format for output repair. A failed repair never starts another repair.
After that repair, malformed JSON or invalid normalization fields become a quarantined
record-validation issue. Provider/authentication and audit/database failures retain their
global recovery or stop behavior; they are never relabeled as a bad record.
Matching now requests a strict two-field JSON schema (`same_place`, `reason`) and validates
both fields in code. It allows 512 final-answer tokens initially and 1,024 for its one output
repair, plus the configured thinking allowance. A second invalid match becomes an explicit
record validation issue, never an implicit match decision. Authentication, unsupported-schema,
database and transport failures are not output repairs; existing transient recovery remains
separate. Invalid matching replies are retained in the private execution journal with provider
call IDs; every real managed request uses the shared provider telemetry and limiter.
Use `pnpm --filter @lib/db-map ingest:test-output-repair` for provider-free failure injection.

Provider-backed normalization cache identity includes provider, endpoint, model,
thinking allowance, output allowance and semantic request settings. Admission tier is
excluded from semantic identity: the historical `service_tier: "default"` key is retained
in the hash for compatibility, while the actual wire tier is recorded separately. Switching
Priority/Standard therefore preserves existing cache hashes and successful checkpoints.
Changes to semantic settings produce a new cache identity for unfinished/newly selected
records. Managed resume still preserves
already completed checkpoints and their original provenance; it does not rewrite
the entire prior run using a new provider. Current resolver/prompt versions are
hybrid-v6 / poi-normalize-v4; both are in the cache key, so older resolver cache results
cannot be reused for pending work. Exact hybrid-v3 / poi-normalize-v2 and interim
hybrid-v4 / poi-normalize-v3 and hybrid-v5 / poi-normalize-v4 checkpoints can resume when every other pipeline
version matches. The execution options audit both version sets while the original
run and artifacts retain their original versions. Other version drift still
requires a new run. Use an explicit new reprocessing run
only when a reviewed quality issue requires that extra work. Deterministic-only
cache keys retain their existing shape. Normalization request rows record the full
non-secret request body, including effective thinking and output limits.

Final successful scope verification records its effective pipeline versions and execution ID
in `research_ingest_runs.counters.verification`. Inventory uses this verification version for
whole-file proof while preserving the original run/artifact versions. Compatible old full
runs remain visible as resumable work; incompatible versions never advertise a resume command.

Run `pnpm --filter @lib/db-map ingest:test-llm` and
`pnpm --filter @lib/db-map ingest:test-provider-recovery` for mocked provider checks.
Run `pnpm --filter @lib/db-map ingest:test-normalization` for source-attribute and
version guards, and `pnpm --filter @lib/db-map ingest:test-normalization:integration`
for an isolated provider-free resume check against the development database.
Management account/model reads can verify key validity and model availability without
inference billing; they do not prove sufficient credits, successful inference, JSON
quality or end-to-end ingestion. Before unattended imports, validate a new 1–5 record
managed smoke through the necessary stages, then update the native scheduled coordinator handoff with the observed
result. Full imports require no spending allowance, unknown-cost approval, ETA or overall deadline.
Follow [agent operations](ingestion-agents.md) for execution.

### Transient provider recovery

Managed normalization, geocoding, embedding, matching and canonical work automatically retry the **same record**, within the same execution,
for HTTP 429/5xx, network errors and request timeouts. Ordinary code owns the cooldown; it does
not invoke an agent, restart ingestion, expand the frozen cohort, or bypass a record dependency.
Authentication/configuration errors, invalid
model output, and database errors do not enter this recovery loop.

The default allows five additional attempts per record, with delays of 30, 60, 120, 240 and
300 seconds plus up to one second of jitter. `Retry-After` (seconds or HTTP date) is a minimum,
even for a non-JSON 429/5xx response. No retry starts after the record's 15-minute recovery
window; an in-flight record can finish afterward, subject to existing 180-second timeouts per
HTTP call (including format fallback/repair). The window bounds retry scheduling, not a hard kill.
A requested delay that cannot fit ends recovery rather than retrying early. There is no
lifetime execution retry cap that a long healthy import can exhaust. Exhaustion fails with stop reason
`provider_recovery_exhausted`; successful checkpoints remain resumable.

Each managed retry appends a new stage attempt and rechecks the execution's normalization
optional provider limits. Hidden HTTP retries are disabled for managed requests. The shared limiter halves concurrency
and applies a provider-wide cooldown on 429/503, honors Retry-After and observed quota headers,
then restores one slot after 15 healthy minutes. Failed requests, repair
requests and JSON-format fallbacks all count as request rows. Existing per-record repair and
fallback calls can still exceed a threshold within a record; these are not universal hard
billing limits. A response lost in transit may have unknown cost and may be billed twice on
retry. Unknown cost is not proof of zero spend.

During cooldown the source/admission locks and five-second heartbeat remain active. Pause,
maintenance and signal requests end the wait within one second of being observed (remote
requests first need a heartbeat); no new provider attempt starts afterward. The smoke
supervisor's original deadline still applies, so a smoke interrupted during recovery is
incomplete, not successful. Use mocked failure injection to test long cooldowns without
provider spend: `pnpm --filter @lib/db-map ingest:test-provider-recovery`.

`ingest:status` prints the current execution's recovery state. JSON includes
`run.counters.providerRecovery` (target, retry time, counts and last state); the local journal
retains every recovery event, and stage attempts retain HTTP status, retryability and
Retry-After. Terminal supervisor evidence includes recovery state and normalization usage
joined to the exact execution ID. Unrestricted executions suggest `--resume UUID --unlimited`,
which clears historical provider caps while preserving checkpoints. Unknown costs are telemetry,
not an admission or approval requirement. If an operator explicitly selects finite caps, the
suggested resume subtracts recorded usage from those optional caps. A bare resume of an old
capped run retains its original limits; the native scheduled coordinator must use `--unlimited` for continuous execution.

```bash
pnpm --filter @lib/db-map ingest:pause --run <uuid>
pnpm --filter @lib/db-map ingest:control stop --run <uuid> --wait-seconds 30
pnpm --filter @lib/db-map ingest:run --resume <uuid> --unlimited
```

The first Ctrl-C or SIGTERM requests a stop after the current unit. A remote pause is noticed
on the next five-second heartbeat. The current provider request/transaction is allowed to
finish; this is not instantaneous cancellation. A second signal exits immediately.
Provider adapters have request timeouts, but retries may extend the total wait.

Each managed invocation owns a PostgreSQL session advisory lock for its source. Heartbeats
use that connection; losing it terminates the worker. The matcher also holds its existing
global match lock during match/consolidation work. Locks protect managed workers; avoid
concurrent standalone mutations or cleanup, which do not share the managed source lock.

On an abrupt kill, the database may still say running. After acquiring the source lock,
a resumed worker marks abandoned execution/attempt rows interrupted, records that the exact
termination cause is unknown, and retries unfinished work. It does not invent an OOM, timeout,
or user-cancellation explanation. Historical legacy runs are not retroactively rewritten.

The printed `lib/db-map/.ingest-logs/<run>-<execution>.jsonl` journal preserves process-local
starts, outcomes, errors and signals when database writes fail. It is ignored by git and
best-effort: retain it with terminal output when investigating an outage. Database history is
the shared authority; a local result entry alone does not prove its audit update committed.

Recovery is **at least once**. Stage transactions and artifact caches make replay safe, but
process death between a provider response/data commit and saving the attempt outcome may
repeat a provider call. Do not promise exactly-once billing. Successful artifacts are reused;
failed attempts stay visible. Run/execution start and final states are updated transactionally, as is freezing the record cohort.

Legacy runs lack execution/attempt history. Status labels their weaker evidence explicitly;
mutable jobs and source-wide timestamps can suggest the stopping point but cannot reconstruct
missing history. `--resume <legacy-uuid>` creates a new managed run linked via
`resumed_from_run_id`, reusing valid data under the original file/options. It does not invent
legacy attempt records.

## Stage behavior and invalidation

- **Extract:** stable `(source_id, source_record_id)` identities; immutable raw observations.
  Each record commits separately and is replayable. Missing IDs/collisions/write failures stop
  advancement. Snapshot removals retire only after an unlimited successful extraction, never
  a sample or interrupted pass. File completion is recorded after retirement/finalization.
  Observation identity includes the raw SHA and a database-generated captured-field/POI-hint
  hash. An extractor mapping change creates a new immutable observation even when raw JSON is
  unchanged, refreshes staging and invalidates normalization. Identical mappings reuse their
  existing observation; old captured snapshots remain available. Bump the extractor version
  for a new extraction pass. Apply the mapping-identity migration only under quiescent
  maintenance and synchronize its matching INSERT conflict target before opening admission.
- **Normalize:** deterministic facts plus evidence-validated model interpretation. Source/URL
  coordinates are authoritative; models cannot invent coordinates, contacts, or identifiers.
  Cache inputs come from immutable captured evidence, never derived projections. Keys include model, prompt/schema/examples/profile/normalizer versions.
  Failed refresh keeps prior valid output and marks it stale. Accepted changes clear derived
  embeddings/geocode pointers, invalidate old geocoded coordinates, and refresh or retire
  memberships/builds according to match changes. Prompt output must retain the input UUID.
- **Geocode:** missing points use forward lookup; missing administrative fields can use reverse lookup. Queries and misses are
  cached. Missing locality or a remembered miss is `blocked`; rerunning cannot fix bad input.
  Successful/reused managed geocode completion requeues completed embed/match/canonical/verify
  checkpoints in the activation transaction, including on compatible older-geocoder resumes.
  Unchanged artifacts may be reused on reevaluation. City, region or country changes clear both
  the embedding vector and active embedding ID; address-only enrichment preserves them.
- **Embed:** normalized POIs need a stored embedding in the managed pipeline. Current managed
  execution uses one-record requests for precise checkpointing. Standalone embedding supports
  batches, but does not provide the managed execution ledger.
- **Match/build:** source coordinates, normalized name/category and embedding stage completion
  feed matching. Decisions, memberships and canonical rebuilds commit together. Managed LLM
  adjudication/fusion errors propagate as failures instead of silently falling back to success.
- **Consolidate:** optional global sweep; pair requests and group merges have nested attempts.
  Existing verdict memos and committed groups support resuming. Reaching the ten-pass bound fails explicitly; resume continues from committed merges and checks convergence. It can be expensive even when
  row matching is limited, so limited managed runs cannot request it.
- **Report/verify:** report failure captures the child output tail. Lineage checks cover
  membership caches, visible canonical membership, build-input counts, dangling artifacts,
  and redirect targets. Success is recorded only afterward. These are structural checks,
  not proof of geographic or editorial quality; they are global and may expose unrelated faults.

Standalone `ingest:extract`, `normalize`, `geocode`, `embed`, and `match` remain compatibility
and maintenance tools. They have their own flags and weaker audit semantics. Prefer managed
runs for new work and record-specific repairs; inspect each parser before using standalone
commands. Their dry-run/provider behavior is not the same as managed `ingest:run --dry-run`.

## File inventory and dashboard

Run `pnpm --filter @lib/db-map ingest:inventory --refresh` after adding or changing captures,
then `pnpm dev:ingestion` to open the local operations app on port 5001. The same assessment
is available as `ingest:inventory --json` or `--file <path> --json` for agent diagnostics.
See the [dashboard guide](../apps/ingestion/README.md) for setup and exact completion rules.

Inventory scans discover untouched files independently of ingestion, hash content, retain old
hashes and missing paths, and preserve operator notes, explicit category, disposition and priority.
They do not call providers or start ingestion. Resolve `needs_review` files before treating them
as an expected import set; alternate exports and supporting JSON are not automatically imports.

The dashboard derives current progress from extraction records, active artifacts, memberships,
build inputs and successful verification scopes. Retries are deduplicated by source record ID.
A completed sample cannot certify a full file. Complete extraction plus ready outputs without
current verification becomes `ready_to_verify`; its command uses `--from report` to check the
whole file. A changed hash/extractor/category requires a new run. Coverage is independent of the
latest execution's outcome and of whether the source file is still present locally.

The inventory tables are `research_ingest_inventory`, `research_ingest_inventory_versions`,
and `research_ingest_inventory_edits`. Current progress is computed, never hand-edited. File
hash state reflects the last scan of this checkout; database progress refreshes independently.
Full histories remain in PostgreSQL; dashboard drill-downs show bounded recent samples.

### Bot queue and classification

`pnpm --silent --filter @lib/db-map ingest:queue --json` returns a compact, versioned snapshot
with admission evidence, action counts, `next`, and per-file actions/argument arrays. It calls
no providers and launches no work. Maintenance or uncertain process evidence suppresses `next`.
Resolve an `inspect` action using its pinned status command; unfinished full-file work takes
precedence over a later smoke selection. A sample resume never appears as full-file continuation.
The queue keeps review/exclusion, progress and execution separate. Fresh inventory is required
after changes; worker locks and file/pipeline/input checks still arbitrate actual admission.

Bots can make the same audited, optimistic classification edits as the dashboard:

```sh
pnpm --silent --filter @lib/db-map ingest:inventory --file data/poi/example.json --json
pnpm --silent --filter @lib/db-map ingest:inventory --file data/poi/example.json --edit-file /absolute/edit.json --json
```

The edit object contains `category_slug` (or null), `disposition`, `priority` (0–3), `notes`,
and the exact `expected_updated_at` from the fresh file snapshot. Exclusions require a reason.
Conflicting edits fail; reread and reconcile rather than overwriting. Scans preserve these
operator fields and batch metadata writes to avoid a database round trip per capture.
Do not maintain a second mutable status file in `data/poi`; database evidence is authoritative.

The [native scheduled coordinator procedure](ingestion-agents.md#native-codex-scheduled-coordinator) owns durable
execution reconciliation and repair handoff. `ingest:status --json` exposes exact per-execution normalization
usage for diagnostics, including failed requests and costs that are still unknown. This telemetry
does not block uncapped imports or require spending approval.

## Assessing category completeness

```bash
pnpm --filter @lib/db-map ingest:report --category <category>
pnpm --filter @lib/db-map ingest:report --source <source> --category <category>
pnpm --filter @lib/db-map ingest:verify
```

Compare expected files under `data/poi/` and source research notes with
`research_source_files` / `research_source_file_versions`. Unimported files have no database
rows; a database-only report cannot prove inventory completeness. Distinguish partial
extraction, intended exclusions, failed/stale normalization, blocked coordinates/embeddings,
match-ready unlinked records, and linked published/hidden output. Counts alone do not prove
artifact freshness or quality. Report includes source-scoped sections and global canonical/cache
sections; read the labels before attributing counts to the selected file/run.

Handoff should state source/file coverage, selected vs remaining records, failure/block reasons,
linked/pending counts, degraded or excluded output, verification results, and the exact next
command. A successful sample must be described as a sample.

## Troubleshooting and optimization

### Database connection acquisition evidence

`pnpm --silent --filter @lib/db-map ingest:database-probe` runs a fixed read-only
matrix: three fresh `pg.Client` connections and nine instrumented pool acquisitions,
including callbacks, three simultaneous clients and two actual 30-second idle expiry
cycles. It requires the reviewed 10-second connection/30-second idle defaults, allows
at most three clients at once, has a 120-second deadline, closes handles on failure,
and calls no providers. Redirect its JSON output to a private ignored receipt. It
does not open maintenance or modify server/network settings. A successful matrix
does not prove prolonged availability or resolve an intermittent failure.

Managed database errors retain their original identity/code/cause. Pool acquisition
metadata adds elapsed time, counts at request start, a caller stack, a code-owned
operation label and the last 64 lifecycle events (no SQL, parameters or endpoints).
`pool_wait` identifies pg-pool's pending-item timeout; it does **not** prove pool or
server saturation. A queued item can subsequently start a new connection.
`connection_establishment` identifies its new-client timeout. Public `connect`
events mean connection establishment finished; these diagnostics do not measure
DNS/TCP/TLS/authentication individually. Event counts are instantaneous: `release`
fires before the driver returns a client to its idle list. Source-lock leases are
expected for the invocation's lifetime, including provider waits.

The private execution journal's `provider_lifecycle` events distinguish preflight
ledger writes, request invocation, observed HTTP response and terminal bookkeeping.
Forward/reverse LocationIQ calls record these HTTP boundaries. Other adapters may
have `request_started=null`, meaning unobserved rather than unsent. Invocation is
not proof of remote delivery or billing. A scheduler DB failure can cancel an active
HTTP call with the same error; inspect the original database caller/label before
attributing a failed provider row to the provider or to its bookkeeping.
Failed terminal bookkeeping is attempted once; its first DB error and any preceding
provider error/HTTP status survive locally. No SQL or provider request is automatically
replayed. A partial preflight/unknown terminal commit requires read/reconciliation.

Description-fusion calls use provider operation `description_fusion`, even when
triggered during a match-stage rebuild. `research_ingest_provider_call_items`
still links them to their actual owning attempts and stages. This purpose label
does not change prompts, provider request bodies, admission, cache keys, or budgets.

Use `ingest:test-database` and `ingest:test-scheduler` for provider-free injection of
pool waiting, actual stalled connection establishment, idle disconnect/removal,
callback/promise cleanup, preflight/result failure and cross-operation cancellation.
Keep systemic holds in place until the diagnostic owner deliberately opens a bounded
validation window. Successful connection probes or one record never authorize a full
import or certify a source/category.

| Evidence                                | Action                                                                                                                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Extraction collision or wrong count     | Check parser, wrapper shape, source identity, ordinal and file hash; fix before normalization.                                                                 |
| Normalization validation/provider error | Inspect linked request, exact UUID, response, validation warnings and profile; reproduce the exact record.                                                     |
| Blocked geocode                         | Check normalized locality, source evidence, cache query/miss and quota. Correct evidence/query or deliberately invalidate the specific cache result.           |
| Failed embed/match/build                | Inspect attempt error and artifact pointers; repair the provider/configuration or responsible algorithm, then resume.                                          |
| Wrong canonical/merge                   | Trace members, decisions, overrides, coordinate election and build inputs; validate known same/different pairs.                                                |
| Old run refuses resume                  | Its pinned input/output or pipeline version changed; start a new run with an explicit repair selection and review cached artifacts.                            |
| Slow run                                | Compare attempt duration, provider latency/tokens/cost, query plans and cache hits on the same sample. Distinguish warm-cache speedups from code improvements. |

Current tradeoffs: canonical matching/fusion remains serialized and can become the next bottleneck.
Matching can hold its transaction across a provider call; decoupling proposal generation from
fenced canonical activation is a future improvement that needs candidate-version checks.
Provider quota headers and reasoning/cost fields may be absent; unknown values stay explicit.
Optional budgets are stage thresholds, not a universal quota service. Standalone legacy scripts
do not gain managed lifecycle registration. Recommendations are advisory and never auto-relaunch,
change models, reduce reasoning or expand scope.
Validation commands:

```bash
pnpm --filter @lib/db-map check-types
pnpm --filter @lib/db-map ingest:normalize:golden
pnpm --filter @lib/db-map ingest:test-recovery
pnpm --filter @lib/db-map ingest:test-work-queue
pnpm --filter @lib/db-map ingest:test-control
pnpm --filter @lib/db-map ingest:test-scheduler
pnpm --filter @lib/db-map ingest:test-inventory
```

The control integration test (`ingest:test-control:integration`) exercises the global gate and
requires quiescence. If maintenance is already enabled, pass `--maintenance-token <token>` to
authorize temporarily reopening it for its isolated one-record fixture. It restores the prior
on/off state, prints the new token when left enabled, and never calls paid providers. Run it
alone, not concurrently with ingestion tests or operator work.

The recovery integration test requires `DB_MAP_URL`, creates an isolated temporary source,
and cleans up its rows. It exercises a fixed cohort, resume without repeated completed work,
real SIGKILL recovery, periodic heartbeat, graceful SIGTERM, source-lock exclusion, retained
failure history, remote pause, latest-execution selection, changed-file refusal, stable cache
inputs, missing-output recovery, and success only after verification. It uses non-POI fixtures and no paid providers. Live provider and output
quality checks remain separate, bounded validation.

## Match and Merge Rules

The matcher uses a cascade:

1. Manual overrides from `research_match_overrides`.
2. Strong IDs, such as Wikidata QIDs and OSM identifiers.
3. Aggressive proximity rules for same-category nearby features.
4. Candidate scoring from name, stored embedding similarity, distance, locality, contact
   fields, coordinate precision, and date compatibility.
5. LLM adjudication for ambiguous gray-zone pairs when LLM is enabled.

Each non-dry-run decision writes `research_match_decisions`.

When a row links to a canonical, `rebuildCanonicalPoi` recomputes the published canonical
from all linked research rows. This prevents description text from being appended repeatedly across reruns. When LLMs are
enabled, ambiguous matching and canonical description fusion can make provider calls;
matching itself does not geocode records or create embeddings.

## Aggressive Conflation

The implemented product stance is to prefer over-grouping for close same-category features,
especially botanical gardens and similar grounds where source data often maps sub-features
as separate POIs.

Important concepts:

- **Anchor**: a stronger canonical, such as one with multiple sources, high source trust, or
  an official website.
- **Satellite**: a weaker nearby feature, often one source and no website.
- **Satellite + anchor**: same-category satellites inside the proximity box merge into the
  anchor.
- **Satellite + satellite**: nearby satellite groups consolidate around a deterministic
  leader/medoid.
- **Anchor + anchor**: proximity alone is not enough; LLM decides when enabled.
- **Same-name block**: distinctive exact-name matches can merge even when coordinates differ
  enough that ordinary spatial blocking would miss them.

Coordinate election prefers corroborated point coordinates over a single high-trust outlier.
Canonical descriptions are rebuilt from source rows and may include contained feature
sections plus `attributes.contained_features`.

## Event POIs

Permanent POIs have no dates. Temporal categories, such as music festivals, use typed date
columns:

- `starts_at`
- `ends_at`
- `date_precision`
- generated `event_range`
- `canonical_poi_occurrences` for recurring editions

The canonical row stores the representative occurrence: next upcoming when available,
otherwise the most recent. Status such as upcoming, ongoing, or past is derived at read time.

## Targeted cleanup

`ingest:clean` removes selected source-record lineage. Use it when removal is part of the task,
not as routine resume or a substitute for fixing failed stages. Capture relevant traces/errors
first. It uses the same file resolver/extractor as `ingest:run`, including synthesized IDs.

```bash
# Review the exact first five parsed records and their impact.
pnpm --filter @lib/db-map ingest:clean <file> --limit 5 --dry-run
# Apply that targeted removal when needed for the task.
pnpm --filter @lib/db-map ingest:clean <file> --limit 5
```

Cleanup deletes selected research rows, observations, normalization/provider artifacts, match
history/memberships, run-record entries, and stale jobs. Orphan canonicals are deleted; shared
canonicals rebuild from remaining research rows. Review that downstream work too: a small
input limit is not a bound on all affected memberships/builds.

Colliding source IDs are grouped: cleanup removes the coalesced database lineage and every
stored observation under it, reporting coalesced input counts. Shared source-file/run metadata
and the shared geocode cache remain. Cleanup does **not** filter by category; its compatibility
`--category` argument is ignored. Do not use it expecting a category-only deletion.

## Standardized location enrichment

Future processing stores a fixed `coordinate_evidence` object with two independently
nullable fields:

- `source_coordinates`: one validated coordinate pair extracted from the listing
  (including a source URL coordinate when that is the source's evidence).
- `inferred_coordinates`: one coordinate pair generated from the original listed
  country/region/city/address text by forward geocoding.

These are provenance categories, not physical roles or two arbitrary candidates.
A second original/source point cannot occupy the inferred field. Source-native
multiple points/roles remain raw evidence; choosing physical launch/landing/entrance
locations is outside this contract. With several linked sources, canonical selection
chooses one value independently per evidence category using the existing anchor/trust
ordering, preserving each selected member/artifact's identity.

Either slot can be absent. A record with only an address-derived point keeps
`source_coordinates=null`. Equal coordinate pairs retain **both named observations**;
only duplicate rendered markers collapse. Different pairs are mapped separately,
without averaging or distance-based suppression. One usable point is required to
publish. Legacy points with insufficient origin evidence keep their existing point
and an explicit legacy/unknown classification rather than an invented source claim.

Forward queries use immutable captured text and source location hints, never fields
filled by reverse lookup or model coordinate proposals. Supplied address/locality
wins over composite venue names for lookup; recognized listed countries constrain
search. Hits and misses are cached by query policy/country. Forward and reverse share
provider budgets and recovery. If the budget expires between calls, activation waits
and resume reuses cached results; a miss preserves a usable source point.

The `location-v3` / `locationiq-location-v4` artifact binds `validation.coordinate_evidence`
to its normalization/primary point, alongside separate listed text, forward query/result
and reverse lookup. Canonical builder `canonical-build-v7` writes
`attributes.coordinate_evidence` with source/research/normalization/geocode IDs for
each value. Legacy lat/lng is the selected source point when available, otherwise the
inferred point or retained legacy point. Raw/model attributes cannot publish these
reserved fields. The query policy remains `listed-location-v1`; unchanged provider
queries reuse the `location-v2` cache namespace, so a representation upgrade does
not repeat already-paid geocoding. No migration or automatic historical sweep occurs.

Forward results now retain the complete selected provider row as `raw_response`
inside the query-cache hit and geocode artifact's `validation.forward.result`.
Compact `precision_evidence` (`geocode-precision-v1`) records the operational
value, its derivation, provider class/type, and diagnostic warnings. Type/class
rules still produce the existing city/region values; other results keep the
existing point fallback with `point_precision_default`, plus
`provider_granularity_missing` when neither field exists. These are diagnostics,
not venue-accuracy claims or matching/publication gates. The selected response
row contains no request URL or client credential. Full raw responses stay out
of canonical coordinate slots; compact evidence survives canonical/API selection.

Existing paid query keys and location/matcher/builder versions stay unchanged.
Replaying an older parsed cache hit keeps its coordinates and stored precision,
marks derivation `legacy_cache` / `precision_derivation_not_recorded`, and does
not rewrite or refetch that cache. Old active artifacts remain current; they are
not swept merely to add metadata. `ingest:location-assess --records <UUID,...>`
adds a read-only `precision_diagnostics` supplement, marking old artifacts
`legacy_artifact` and stating whether the original provider row is available.
This supplement does not alter immutable assessment policy, hashes, or status.

The map API exposes `coordinate_evidence` plus a rendered `locations` array. Markers
use stable `<POI>:source`, `<POI>:inferred`, or `<POI>:legacy` IDs and a shared POI detail
ID. Missing source data never renumbers an inferred marker into the source identity.
Each point is filtered by viewport; entity limits precede marker expansion. Details
show both named evidence values (even if equal), their origin, query and precision.
The ordinal `location_index` is presentation order, not provenance. Cluster counts
count markers. Approximate locality points do not establish venue/entrance precision.
A future source/inferred/both display policy can select these fields without rerunning
ingestion or losing the other observation.

The managed geocode stage also fills missing administrative/address fields for valid points.
Source addresses/locality win; country values use the pinned ISO country dataset. Reverse
LocationIQ fields are approximate, cached by exact point and policy version, and never move
valid source coordinates. Country/region conflicts, distant results and missing fields remain
visible in `research_pois.attributes.location_enrichment` and the bound geocode artifact.
A definitive optional reverse miss does not fail the geocode stage for a coordinate-bearing
POI. The assessment records that missing evidence and still lets the source point publish.
API failures retain normal bounded recovery and systemic stop behavior. Source-precision centroids do not
receive inferred street addresses. Forward and reverse calls share `--geocode-limit`.

Canonical builds publish selected `attributes.country_code`, `city`, and `region` with
member/derivation provenance. A versioned location artifact binds normalization and point;
old coordinate-only geocode checkpoints do not establish enrichment. Existing completed
cohorts are preserved; deploying this code does not mass-backfill historical records.

### Location assessment

`location-assessment-v1` appends an input-hashed diagnostic after location evidence
exists. It binds the observation, normalization, geocode, and point/provenance
snapshot. `research_pois.active_location_assessment_id` selects the current row.
Outcomes are `accepted`, `needs_review`, and `unlocated`. When both coordinate
slots exist, `evidence.distance_m` stores their separation. Reasons, the forward
country filter, and the snapshot remain available through `ingest:trace`. Accepted
means the diagnostic found agreement. It is not a publication requirement and it
does not verify a venue or an edition.

`matcher-v3` scores the research row's stored point. `canonical-build-v7` publishes
every plottable candidate. A source point with no inferred point, reverse result,
or country text still publishes. Far-apart and cross-country candidates publish
both markers. Equal coordinates keep both evidence records and one marker. A
record with no plottable point stays unpublished and its assessment is
`unlocated`; the raw observation and listed text remain. Member disagreement does
not hide the canonical or quarantine the record.

Build inputs still store the current assessment ID, including `needs_review`.
Checkpoint reuse requires that current snapshot binding and the v7 builder. It
does not require `status=accepted`. An inactive membership on a live research row
keeps the previous serving snapshot during a normalization refresh. Explicit
retirement, exclusion, and cleanup still withdraw output. Paid provider query
caches stay reusable. Deploy the additive assessment migration before running
this ingestion code. Deploying it does not backfill historical rows.

A normalization refresh may retain its previous serving snapshot while the live record
has no active membership. Once rematching creates a replacement membership and publishes
its canonical, rebuild and hide the old canonical when it has no active members; a
completed rematch is not a pending refresh. The lineage verifier must flag a stale
published duplicate.

The [implementation record](../working/location-assessments.md) has the 94-case
diagnostic regression and the correction that removed the #62 acceptance gates.

That Festival Site's split listing labels mix cities, regions and countries. Its version-4
extractor retains them in `source_location_hints` and the original observation, while
leaving administrative columns for the coordinate lookup. The normalization resolver
enforces `location_admin_policy=coordinate_lookup` against both model proposals and
deterministic fallbacks, so raw labels cannot be promoted back into these fields.
The captured policy revision participates in observation and normalization cache identity.
A label such as `California`
is not asserted as a country, and `Australia` is not asserted as a city. Source points,
supplied street addresses, natural IDs and captured edition dates remain unchanged.
Its code-owned normalization context omits the opaque `lineup` array from raw and
captured attributes while retaining `lineup_count`. The full lineup stays in immutable
observations/research attributes. This prevents thousands of performer names being
echoed into a scalar response; the actual curated packet participates in cache identity.
Use `pnpm --silent --filter @lib/db-map ingest:location-audit --json` for a read-only current
completeness/conflict/inference audit. See [location rollout](../working/location-standardization.md)
for the baseline findings, field contract, limitations and staged historical repair plan.

### Reviewing location evidence on completed records

`ingest:location-review` is a separate read-only diagnostic. It neither repairs data nor
imports the ingestion worker/provider clients, and can run while an import is healthy.
Export defaults to **40 current published canonical-build/source-member pairs**, capped at
100, with a repeatable seed and optional source/run filters. A source/record must have a
successful record-verification checkpoint in a succeeded, verified run. The packet states
whether that checkpoint binds the current normalization, observation, or record identity
only; a newer build is not claimed to have been verified by an older checkpoint. Manual
canonicals without managed completion evidence are outside this sample.

From `lib/db-map` (or through `pnpm --filter @lib/db-map`):

```sh
pnpm ingest:location-review export --limit 40 --seed first-location-review \
  --out .ingest-jobs/location-review-first
# Optional narrower scope: --source jambase --run <completed-run-uuid>

# Pin mandatory POIs and include every linked build member (up to 100 rows).
# Manifest: {"version":"location-review-selection-v1","canonical_ids":["<uuid>"]}
pnpm ingest:location-review export --selection /absolute/selection.json --limit 100 \
  --seed coordinate-review --out .ingest-jobs/location-review-selected

# Copy decisions.template.json to a dated file, enter field judgments, then:
pnpm ingest:location-review summarize \
  --packet .ingest-jobs/location-review-first/packet.json \
  --decisions .ingest-jobs/location-review-first/decisions.YYYYMMDD.json \
  --out .ingest-jobs/location-review-first-summary
```

The single repeatable-read database snapshot has a 10-second statement timeout, 1-second
lock timeout, and no provider calls or database writes. Each output directory must be new.
`review.md` lists candidate inconsistencies and comparison/coverage cases: event/edition,
listed country, listed address/locality, and stored reverse address. `field-lineage.md` and
`packet.json` add context, raw/captured/normalized/canonical values, exact artifact IDs,
physical tables/columns/JSON paths, point binding, canonical field provenance and hashes.
Missing bound reverse evidence stays unassessed. No extra lookup is silently performed.

New exports use `location-review-v2`. They include independently nullable source/inferred
coordinate evidence from geocode validation and canonical attributes, each point's saved
owner/query/precision, builder/provider versions, listed/forward evidence, and normalization
venue/edition context. These values participate in the evidence hash. Equal points retain
both records. Missing historical slots are coverage gaps, not automatic repair instructions.
Offline summarization still accepts immutable v1 packets and their original labels.

`--selection` accepts 1–100 unique canonical UUIDs and cannot combine with `--source` or
`--run`, which could hide another member's provenance. Its default member limit is 100;
the limit counts source/build pairs, not unique POIs. Export fails rather than truncating
members, omitting unavailable requested POIs, or silently losing a member with missing
normalization/observation evidence. Explicitly selected members without a successful
managed checkpoint are marked `missing_verification`; they are not presented as verified.
In this mode population counts describe only the selected canonical IDs. Seeded sampling
retains its original verified-record eligibility and source/stratum balancing.

For a read-only browser review, use the merged-main app with read-only database sessions.
Intercept mutation requests: map movement normally saves guest viewport preferences.
Use a local/cached basemap and block external provider requests. Keep live API responses,
browser evidence and isolated SQL/browser fixtures separately identified; unavailable
live equal-point or single-slot examples must not be replaced by shared-database writes.

Selection alternates source/stratum slots across prioritized risk cases, baseline cases,
and records with no bound reverse evidence. It surfaces existing country/region/distance
warnings and city differences only when the resolved geocode and saved reverse point
bind the build's normalization and valid coordinates. Stale, rejected, missing or
otherwise unbound evidence enters the no-bound-reverse group with no risk priority.
Baseline cases can reveal new address or extraction
differences. Country disagreement, lexical city/address differences, and missing evidence
are distinct findings, not adjudicated errors. This diagnostic sample is deliberately
biased toward useful cases; its counts must not be presented as population error rates.

Field judgments bind packet ID, case ID and the saved evidence hash. Use `correct`,
`incorrect`, `uncertain` or `not_applicable`; record a note or evidence URL for positive
correct/incorrect judgments. Review scope is `event_location`, or `coordinate_lookup`
for a reverse field. A reverse result can be right for the query point and wrong for
the event. Offline summaries group judgments by source, sampling stratum, step, physical
field and scope. They reject stale evidence/unknown fields/duplicate judgments, preserve
dated decisions, and never change precedence or write a repair. See the
[review workflow](../working/location-review-workflow.md) for human review and follow-up.

Unbound reverse findings identify the failed binding fields: artifact normalization,
saved validation normalization, status, or the artifact/saved query-point comparison.
`geocode.status` includes its physical table/row/column locator. Country-name findings
likewise cite the raw field or captured country-name fallback that supplied the value.
Existing packets and decisions remain immutable; after integrating a diagnostic fix,
export into a new directory to obtain corrected evidence references. Keep prior human
judgments with their original packet ID and evidence hash.

Run `pnpm --filter @lib/db-map ingest:test-location-review` for the offline tests.
To include the SQL sampling regression, set `LOCATION_REVIEW_TEST_DATABASE_URL` to
an isolated PostgreSQL database named `map_location_review_test` on `127.0.0.1` or
`localhost`. It uses only session-local temporary fixture tables. With that
variable unset, the SQL test is explicitly skipped; no shared database is used.

### Canonical origin repair and resume

`canonical-build-v7` preserves fixed source/inferred coordinate provenance and legacy origins, and publishes conflicting candidates. Deploying it does not
rewrite historical data. `canonical-build-v5` and the acceptance-gated `canonical-build-v6` remain resumable predecessors. On an explicitly selected new run or compatible resume,
completed downstream tasks and batch/attempt caches reject older builders. The
match stage rebuilds the existing canonical from its active members when its build
is stale; it retains memberships and does not repeat match adjudication. Current
normalization, geocodes and embeddings remain reusable. Canonical/verify tasks then
record the new build, and a second resume reuses it. Existing location-version
upgrades still follow their own readiness rules. Use the normal managed scope and
maintenance procedure for any deliberate repair; this is not a background backfill.

Validation: `MAP_CANONICAL_TEST_URL` may explicitly select a disposable loopback
PostgreSQL database named `map_canonical_cache_test` for
`pnpm --filter @lib/db-map ingest:test-canonical-cache`. The test creates temporary
tables only, refuses other hosts/database names and ignores `DB_MAP_URL`; without
that dedicated variable the SQL test is skipped. It exercises stale task/checkpoint
and batch-reuse rejection, retained geocode/embedding checkpoints, and reuse after
a fixture builder refresh. It does not execute a live repair or assert provider quality.
