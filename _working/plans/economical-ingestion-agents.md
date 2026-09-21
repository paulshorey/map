# Economical ingestion orchestration

The smart orchestrator decides and repairs. One explicitly selected GPT-5.6 Luna runner starts
the approved managed command. A detached, non-AI supervisor owns the OS child, logs and hourly
health checks; ordinary waiting consumes no model tokens. A compact terminal report is optionally
summarized once by Luna and delivered to the idle orchestrator through the local Codex app server.
No model polls a healthy worker. No full campground run is part of implementing this system.

Build:

- Durable local job manifests, raw logs, compact results and delivery outbox; argv-based launch
  of the managed script only; maintenance and source locking remain authoritative.
- Separate smoke command: explicit small cohort and automatic wall-clock stop, followed by
  targeted forced termination of the child process group if graceful termination times out.
- Hourly deterministic health probes, event-driven exit detection, no auto-resume/retry loops.
- One terminal event per job. Delivery defers while the parent is active/offline. Ambiguous
  delivery stays uncertain for operator review instead of repeatedly waking the expensive model.
- Explicit cheap runner configuration and small handoff prompts; parent ends its turn after
  setup instead of waiting/polling. Document native subagent lifecycle limits and host availability.
- Fixture tests for quiet execution, success/error/pause, timeouts, durable output, admission,
  compact escalation and mocked delivery. Verify model selection with an actual cheap subagent.

Research (2026-09-20): official OpenAI subagents, AGENTS.md, scheduled-task, model and app-server
documentation. See `ingestion-agents.md` for sources, compatibility and operating instructions.

Implemented and validated:

- Explicit Luna role and native Luna delegation used for development and the live fixture.
- Detached jobs, hourly model-free health checks, IPC identities, process-group deadlines,
  bounded smoke scope, durable terminal evidence and conservative outbox receipts.
- Unit transport/process tests and a real one-record smoke/resume fixture (no providers or
  reporter calls); package type/contract checks. Experimental fixture data cleaned up.
- No schema change needed; existing run/execution/attempt/checkpoint tables remain authoritative.
- Installed the official standalone Codex CLI and bootstrapped its private local managed daemon.
  Terminal callbacks use the supported shared task queue. Remote control remains disabled.
- No full import started. Maintenance reopened after static validation.
