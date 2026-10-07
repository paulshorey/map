# Dyrt source lock loss, 2026-10-07

Run `4dda8606-9c20-4275-bae6-c14cdea9e38c` retains its 43,272-record Dyrt cohort and
completed artifacts. Executions `57354060-311c-43a0-97e7-c4347d028688` and
`886d8c40-05ab-431f-89ff-5cf474cfe11b` exited after their dedicated PostgreSQL
advisory-lock client emitted `error`. The old handler logged no underlying driver error.

The second execution's last committed normalization and heartbeat were at
2026-10-07 03:08:08 UTC. macOS `pmset -g log` recorded system sleep at 2026-10-06
22:08:08 CDT and wake at 22:24:21 CDT; the worker then exited at 03:24:24 UTC.
The first execution has no corresponding sleep event in the available power log, so
its connection-drop cause remains unproven. The pool's 30-second idle timeout does
not apply to the checked-out lock client, which receives a query every five seconds;
the lock transaction is committed before normalization begins.

Maintenance was entered with token `6947107f-c2fc-47cf-8000-864c7ec4316d`.
The previous execution row still said `running` although its source/admission locks
were absent. The recorded short host `Pauls-MacBook-Pro` matched this Mac's local
hostname, but `os.hostname()` temporarily returned the FQDN, so the control CLI
classified it as remote. PID 96670 was absent and local process discovery was empty.
The absent execution was reconciled through `reconcileAbsentExecution`, preserving
attempt/error history and pausing the run. Subsequent `ingest:control list --json`
reported `quiescent=true` under maintenance.

Fix: non-dry-run macOS ingestion holds a process-bound `caffeinate -i -s` assertion.
The lock-loss handler now records the actual client error before the existing recovery
exit. No automatic relaunch or checkpoint reset is introduced. The source lock still
fences writes; a genuine disconnect still exits for manual/coordinator resume.

Validation: `pnpm --filter @lib/db-map ingest:test-supervisor` passed 21 tests,
including a macOS `pmset` check that both sleep assertions remained active for the
worker PID after one second. `pnpm --filter @lib/db-map check-types`, `pnpm lint`,
Prettier, and `git diff --check` passed. The pre-existing root lint failure from
Next's generated `apps/map/next-env.d.ts` was addressed by ignoring that file in
the app ESLint config. No provider-backed smoke or full import was started; the
sleep assertion was not tested across a real 16-minute sleep. The previous
execution's original PostgreSQL error is unavailable because the old handler
discarded it.

Maintenance was exited after static checks. Control reported `maintenance=false`,
`quiescent=true`, no workers and no source/admission locks. The run remains
`paused` at `normalize` with its 43,272-item cohort intact.

After PR merge, the coordinator's checkpoint-preserving arguments are
`--resume 4dda8606-9c20-4275-bae6-c14cdea9e38c --unlimited`.
