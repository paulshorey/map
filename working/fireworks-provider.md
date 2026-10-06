# Fireworks provider PR — 2026-10-05

Scope: review PR #30, merge current main into its feature branch, configure Fireworks
DeepSeek V4.1 Flash thinking, and validate offline. The user deferred inference and
ingestion testing until their payment step. No paid model request or full import is
part of this change. Account/billing details and credentials are kept out of Git.

Main baseline: `e9c464d72fb0abc98b3f91baf442bd97bcc78037`.
Feature branch: `cursor/fireworks-llm-provider-828c`.
PR: <https://github.com/paulshorey/map/pull/30>.

Review corrections:

- Enable high thinking with a default 2048-token reasoning cap. Add it to each caller's
  final-answer allowance, including the short date path. Reject invalid cap values.
- Retain the documented JSON Schema wrapper; narrow fallback to an explicitly
  unsupported format instead of retrying unrelated 400s.
- Update standard serverless fallback pricing and preserve unknown cost for other
  models or malformed/missing usage. Include thinking output once.
- Preserve returned usage on truncated/empty final responses. Truncation stops for
  diagnosis rather than repeating an identical inadequate request as an outage retry.
- Include effective provider/thinking settings in normalization cache identity and
  journal the actual non-secret wire request. Keep completed managed checkpoints.
- Update the cloud setup script, shell configuration catalog and human runbook.

Development uses a managed worktree. Maintenance was entered and confirmed quiescent
before runtime changes. No existing import needed stopping or restarting.

The remaining live validation is a managed new-cohort smoke, then downstream checks
as appropriate. After those pass, review the OpenClaw handoff and carry forward existing
budget/unknown-spend/completion requirements before any backlog operation. The PR remains
draft pending live provider validation; merging main into this branch does not deploy it.

Validation completed:

- Mocked Fireworks client tests: 11 passed. Provider recovery tests: 12 passed.
- Normalization golden fixtures passed. Package types and generated contract checks passed.
- Workspace `pnpm verify` passed, including map app types and production build. Existing
  Next.js ESLint-plugin and Node deprecation notices are unrelated to this provider change.
- Shell bootstrap syntax and Git whitespace checks passed.
- Maintenance reopened after static validation; process discovery confirmed no workers,
  source locks, admission locks or local ingestion writers. Existing imports remain paused.
- Local host credentials were aligned to the existing OpenClaw Fireworks key at the user's
  request. Key validity was verified with free management reads; no credentials are stored
  in this report or repository. No inference or ingestion call was made.
