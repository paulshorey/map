# Ingestion process ownership and maintenance

Agents and humans share operational ownership of this experimental database. Before changing
ingestion runtime code or schema, discover workers, pause them, prove their locks/processes
have stopped, and prevent replacement workers from starting until validation is complete.

Implementation:

1. Add a persistent database maintenance gate and append-only operator event history.
2. Serialize worker admission with gate changes; retain a shared worker advisory lock for
   the entire execution, including startup before a run exists. Heartbeats honor the gate.
3. Add `ingest:control` for JSON/text worker evidence, stop-and-wait, maintenance enter/exit,
   and evidence-based reconciliation of abandoned executions. Token-check maintenance exit.
4. Report recorded status, source locks, local PID evidence, and unregistered local script
   processes separately. Never infer termination causes or kill unrelated processes.
5. Update agent guides and the runbook with standing operational authorization and the
   mandatory stop/edit/validate/reopen workflow. Keep bounded validation as the default,
   while allowing necessary lifecycle operations on human-started full runs.
6. Validate admission blocking, concurrent startup, stop requests, timeouts, stale execution
   handling, token ownership, and recovery on isolated records without paid providers.

Limits: legacy standalone scripts do not acquire managed locks; local discovery is a safety
check, not a cross-host supervisor. Use managed runs as the standard writable interface.
No full import, data reset, automatic restart, or arbitrary-command web endpoint is needed.

## Implemented and validated

- Applied `202609201716__ingestion_control.sql` through `db:sync`; regenerated schema/types.
- Added the control CLI, persistent gate, admission locks, heartbeat stop check, action audit,
  evidence-based local reconciliation, dashboard maintenance indicator, and operator guides.
- Reconciled the absent campground execution without removing artifacts or attempt history.
  Its logical run remains paused. Resume dry-run accepts its existing file/version/options.
- Control unit/integration tests, recovery and cache-queue integration tests, database/app
  typechecks, dashboard authorization tests, and live maintenance-banner inspection passed.
  Fixtures were isolated and cleaned up; no paid providers or full imports were run.
- Maintenance reopened after validation; the campground import was not restarted.
