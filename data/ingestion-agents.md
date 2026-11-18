# Running ingestion as an agent

One rule shapes everything here: **no model is involved while an import runs.** A detached
Node process owns the worker, checks its database heartbeat once an hour, and writes a
durable result when it exits. An agent starts work, ends its turn, and looks again later.
The database checkpoints remain the source of resume truth.

The [runbook](poi-ingestion.md) owns pipeline behaviour, process control and recovery. Read
its [process control and maintenance](poi-ingestion.md#process-control-and-maintenance)
section before changing anything that a running worker uses.

## Which command

| You want to | Use |
| --- | --- |
| See workers, queue and recent outcomes | `ingest:overview --json` |
| Inspect indexed captures and their current coverage | `ingest:inventory --json` |
| Import whole files | `ingest:import-queue start` |
| Try a change on 1–5 records, time-limited | `ingest:supervise smoke` |
| Debug one record through chosen stages, in the foreground | `ingest:run … --record <id> --stop-after <stage>` |
| Start one detached run outside the queue | `ingest:supervise start` |
| Stop work | `ingest:import-queue stop [--now]`, or `ingest:control stop --run <uuid>` |

Use the primary checkout for inspection and whole-file imports. When it is in use by another
task, run pinned, bounded smokes from a synced worktree. Before removing the worktree,
copy the smoke’s job receipt and logs from `lib/db-map/.ingest-jobs/<job-id>/` to private
storage outside the worktree and record the new paths. Whole-file queue start and resume
require the primary checkout.

## Inspect ingestion status

1. Start with `ingest:overview --json`. Read `worker_liveness` for the confirmed count.
   Confirmation requires a fresh heartbeat and matching admission and source locks.
   On the primary host it also requires process identity. Unfinished journals with
   `assessment: terminal_execution` reference an execution that already ended.
2. Pin IDs from `import_queue.current` and `recent_executions`. The current entry can
   get its IDs from the supervisor journal before the queue records a result. A queue
   may hold its lock while waiting for quota with no active ingestion worker.
   Use `ingest:import-queue status --json` for the full queue. That command can mark an
   abandoned queue as stopped in its journal.
3. Use `ingest:status --run <uuid> --json --limit 10` for the pinned run and
   `ingest:issues list --run <uuid> --json` for issue dispositions. To get a job receipt,
   use `ingest:supervise status --job <uuid>` or read its `result.json` if the final
   job save was interrupted. Keep raw logs private.
4. Compare a queue entry's recorded coverage to current inventory coverage.
   `summary.coverage_counts` counts each import file once, independently of execution
   and sampled quality. For visible files ready to verify, `verification_evidence`
   reports current builds and artifacts newer than the matching whole-file verification.
   Capture warnings distinguish a file on disk awaiting a scan from a missing file.

For diagnosis by failure class, see the [troubleshooting table](poi-ingestion.md#troubleshooting-and-optimization).

## Whole-file imports

```sh
pnpm --silent --filter @lib/db-map ingest:inventory --refresh     # the queue refuses unscanned changes
pnpm --silent --filter @lib/db-map ingest:import-queue start --plan data/import-plans/<plan>.json
pnpm --silent --filter @lib/db-map ingest:import-queue start -- data/poi/x.json=art_fair data/poi/y.json=hostel
pnpm --silent --filter @lib/db-map ingest:import-queue status
pnpm --silent --filter @lib/db-map ingest:import-queue stop        # before the next file
pnpm --silent --filter @lib/db-map ingest:import-queue stop --now  # also stop the current import gracefully
pnpm --silent --filter @lib/db-map ingest:import-queue resume
```

The queue runs one file at a time, starts the next only after the previous one succeeded
with `coverage: complete`, waits out the daily geocoding quota, and stops as
`needs_attention` on anything else. The one thing it retries by itself is a run that only
lost its database connection, at most twice per file. The exact rules are in the
runbook's [sequential import queue](poi-ingestion.md#sequential-import-queue).

After starting it: record the queue ID, check once after a few minutes that the first file
is progressing, then end the turn. Check back infrequently (every 30 minutes or more).
A provider cooldown with a current heartbeat is expected; leave it alone.

When the queue stops as `needs_attention`, use the [status steps](#inspect-ingestion-status)
to identify the earliest failed stage and any open issues. Resume the original scope once the
cause is understood and cleared. A repeat needs a code or data fix. Check the file fingerprint,
extractor and checkpoint compatibility before resuming.

## Bounded checks: smoke

```sh
pnpm --silent --filter @lib/db-map ingest:supervise smoke --timeout-seconds 45 -- \
  <source-file> --category campground --limit 1 --stop-after normalize \
  --max-llm-requests 1 --max-cost-usd 0.10
```

`smoke` rejects `--resume` (which can carry a huge cohort), consolidation, duplicate cohort
flags and limits outside 1–5. Its deadline is 1–60 seconds, followed by 10 seconds of
termination grace. A row limit alone does not ensure a short run. If a smoke times out,
inspect its evidence; do not chain more smokes to drain a backlog. A run stopped by
`--stop-after` is partial, not successful.

## A single detached run

```sh
pnpm --silent --filter @lib/db-map ingest:supervise start -- --resume <run-uuid> --unlimited
pnpm --silent --filter @lib/db-map ingest:supervise list
pnpm --silent --filter @lib/db-map ingest:supervise status --job <job-uuid>
pnpm --silent --filter @lib/db-map ingest:supervise stop --job <job-uuid>
```

`start` detaches, prints a job receipt and returns; `watch` is the same in the foreground
and is what the queue uses. A later queue that lists the same file adopts such a run when it
ended at the daily geocoding quota or an operator stop, and resumes it with its checkpoints;
any other unfinished run stops the queue for a decision. Neither notifies anyone. (`--local-only` is still accepted and
ignored: it used to choose between a parent callback and none, and there is no callback now.)

Each job has a private, ignored directory `lib/db-map/.ingest-jobs/<uuid>/`:

- `job.json`: launch scope, process IDs, host, pinned run and execution IDs, status.
- `worker.log`: raw worker output. Detached jobs can also write `supervisor.log`.
  Queue-driven `watch` supervisor messages go to the queue log. Read bounded excerpts privately.
- `result.json`: exit code or signal, stop reason, verified database outcome, recent
  attempts, a bounded error tail and the exact resume command.

Hourly probes stop a child with a stale heartbeat (over 120 seconds at the probe), a
terminal execution despite a live child, missing identity, a failed database probe, or no
recorded progress for two hours. The supervisor never retries ingestion. Verified database
success plus exit zero is required for success; partial, budget, paused and error are
distinct outcomes.

A stop asks the supervisor's own child process group to finish gracefully, then forces it
after the grace period. It never signals a saved PID. After a forced stop, use the runbook's
process and lock checks and reconciliation before a resume.

## Limits

- The machine must stay awake. On macOS the worker holds a sleep assertion while it runs
  (see the [runbook](poi-ingestion.md#process-control-and-maintenance)); a closed lid,
  battery power or a dropped connection can still end it. A detached process survives a
  closed terminal, not a reboot.
- Nothing restarts an import after a reboot or a killed supervisor. Job files survive:
  inspect them with `ingest:control list` and reconcile an absent execution. Then, for a
  file that was running in a queue, `ingest:import-queue resume`. For a run started with
  `ingest:supervise start` outside any queue there is no queue to resume: continue it with
  `ingest:supervise start -- --resume <run-uuid> --unlimited`.
- Provider recovery (HTTP 429/5xx) is handled inside the worker; see
  [transient provider recovery](poi-ingestion.md#transient-provider-recovery). After
  `provider_recovery_exhausted`, check availability and configuration before another launch.

## Tests

`pnpm --filter @lib/db-map ingest:test-supervisor` runs the local process tests with ordinary
Node children. `ingest:test-supervisor:integration` needs open admission and quiescence, uses
one non-POI record and zero provider budgets, and cleans up its fixture data.
