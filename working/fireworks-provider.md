# Fireworks provider PR — 2026-10-05

Scope: review PR #30, merge current main into its feature branch, configure Fireworks
DeepSeek V4.1 Flash thinking, merge the PR at Paul's request, and validate one record
through publication. Full imports belong to the local OpenClaw runner. Account/billing
details and credentials are kept out of Git.

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

PR #30 was merged into main on 2026-10-06 at 04:25:21 UTC as
`20ac0c84067db26b49aaa00e3d83a69ed016cf78`. The local main checkout includes that merge.
The earlier deferred-payment testing constraint was superseded by Paul's request to test.

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
  in this report or repository. The initial account check made no inference call.

## Live validation after merge — 2026-10-06 UTC

Under a 45-second supervisor deadline, a NEW one-record cohort for The Dyrt source record
`17196` (Pioneer Pass Campground) completed normalization with Fireworks
`accounts/fireworks/models/deepseek-v4p1-flash`. The request used `reasoning_effort: 2048`
and `max_tokens: 3848`; finish reason was `stop`. Provider latency was 10.611 seconds,
with 2,438 input and 2,590 output tokens. One request cost an estimated $0.0038394,
with no unknown cost. The smoke intentionally paused after normalization rather than
claiming full-file completion.

- Normalization run: `0ff644f7-a7d6-42c8-8aa8-37afafe8d9ba`.
- Execution: `2bb572e7-ced3-4c79-818a-02fd85f88955`.
- Supervisor job: `b65ff076-5973-4374-b6c5-4518e22be9ff`.
- Active normalization: `e3b79445-0e72-4d6b-96ff-cfe748649154`.

A second NEW one-record smoke reused that exact normalization with zero normalization
and geocoder allowances and completed all downstream stages. It made one Jina embedding
call, reused source coordinates, matched automatically to a new canonical, published it,
and passed report/lineage verification with zero violations. This is a successful
development-database import of the sample, verified at `2026-10-06T04:27:45.618Z`.
Zero normalization allowance does not make embedding/matching/fusion provider-free.

- Published run: `9a89aa13-2f8d-427b-b498-522d74e497c7`.
- Execution: `4ccc34ea-81e5-404b-9df1-0e8b9db403dc`.
- Supervisor job: `22bb303e-1266-4077-a74a-9c998c607f5b`.
- Canonical: `bca288ad-0de4-4706-af7d-ae35df942a16`.
- Published build: `8758e0eb-b253-45c9-a1ec-d38517c5188a`.

Live evidence: `/tmp/poi-fireworks-smoke.json`, `/tmp/poi-fireworks-publish-smoke.json`,
`/tmp/poi-fireworks-lineage-audit.json`. Geocoder API calls, ambiguous LLM matching,
fusion and date inference were not exercised by this sample. Mocked Fireworks/recovery
tests passed again on merged main (11 and 12 tests). Prior package/app/contract/build
checks remain applicable because merging did not change the tested provider implementation.

The original full run `4dda8606-9c20-4275-bae6-c14cdea9e38c` is still paused and its
resume dry-run accepts the file hash and retained scope. A later successful sample does
not replace it. Maintenance is off; no full backlog run was launched. See
[the operations audit](poi-openclaw-operations.md) for coverage and OpenClaw readiness.
