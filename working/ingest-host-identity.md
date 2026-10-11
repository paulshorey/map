# Ingest host identity repair — 2026-10-06

The live Dyrt execution `57354060-311c-43a0-97e7-c4347d028688` recorded
`Pauls-MacBook-Pro.local` with PID 4008 in both its execution journal (14:18:23Z)
and the native supervisor job `86a59d26-16b6-4fc5-ab03-191e818212d4`
(14:18:21Z). The native OpenClaw launcher invokes `ingest:supervise watch`;
`supervise.ts` stores `os.hostname()` in the job, and the spawned `run.ts` worker's
`Execution.start()` stores its own `os.hostname()` in PostgreSQL. The execution
constructor uses the same API for the journal. Neither path appends `.local`.

At investigation time, `os.hostname()`, `kern.hostname`, `hostname -f`, and
`scutil --get LocalHostName` all returned `Pauls-MacBook-Pro`. A fresh child Node
process returned the short name even with `HOSTNAME=Injected-Name.local`. Thus
the suffix came from the OS hostname at launch, which differed from the OS
hostname at inspection. The exact system event that changed it has not been
identified. `scutil --get HostName` is unset; ComputerName is `Paul’s MacBook Pro`.

`ingest:control list` used exact string equality, so it classified this local
worker as `remote_unknown`. The same comparison in supervisor job listing hid
local PID status. Both now use one helper that equates the short name with its
single-label `.local` form, ignores DNS case, and preserves exact matching for
other FQDNs. Distinct domains or host labels remain remote. Reconcile still
requires a quiescent snapshot and an absent PID.

This was a source-code-only repair in an isolated worktree. The live Dyrt worker
was not stopped, restarted, or admitted to a new run; maintenance was not entered.

Validation in the worktree: `pnpm --filter @lib/db-map ingest:test-control` passed
4 tests, `pnpm --filter @lib/db-map ingest:test-supervisor` passed 21 tests, and
`pnpm --filter @lib/db-map check-types` passed. The read-only
`ingest:control list --json` check found this exact live execution with
`local_process=present_identity_unverified`, `source_locked=true`,
`quiescent=false`, one source lock and one admitted worker. Maintenance remained
off.
