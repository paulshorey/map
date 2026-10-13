# Ingestion observability implementation

Status: implementation complete; operational rollout and validation in progress (October 12, 2026).
PR: https://github.com/paulshorey/map/pull/40

## Baseline and decision

The audit accounted for 247 captures (234 JSON / 13 CSV, approximately 745 MB): 160 intended
imports, 77 supporting/alternate/ignored captures and ten requiring classification review.
Only two files were structurally complete, with all 58 normalized records degraded. No category
had established quality acceptance. Dyrt had extracted 43,272 records and was processing
normalization serially. In the most recent 1,000 attempts, approximately 18.55 seconds per record
included 17.75 seconds of provider waiting (96%). These are dated measurements, not progress state.

The user selected LLM normalization for every eligible POI, preserving the current model,
prompt and thinking settings. Record-specific failures should be isolated; systemic errors
must stop. Full Dyrt resume with the new implementation is authorized. No raw-data reset is needed.

## Delivered architecture

- Durable record/stage tasks with fenced claims and atomic artifact/attempt/task commits.
  Extraction/cohort freeze stays a barrier; subsequent stages pipeline independently.
- Shared four-slot LLM admission (configurable 1–16), observed quota spacing, shared cooldown,
  adaptive concurrency and bounded per-record provider recovery without a lifetime retry cap.
- Downstream priority/backpressure, one-per-second geocoding, embeddings in batches up to 32,
  serialized canonical writes under the existing database lock, and exact record certificates.
- Record quarantine and reasoned retry/exclusion events, plus a systemic circuit breaker after
  ten consecutive stage validation failures. Whole-file success still requires global verification.
- A shared versioned overview/doctor CLI and loopback API, bounded details and pagination,
  known/unknown evidence, intervention commands, exact IDs and explicit freshness clocks.
- Durable provider timing/tokens/cache/cost/quotas, database timing, scan receipts and stable
  host/process identities. Scan serialization no longer conflicts with the worker/drain lock.
- Dashboard operations/performance/quality panels using the same assessment. Audited expected
  capture catalog and sampled quality reviews remain separate from structural completion.

The [runbook](../data/poi-ingestion.md) owns operational facts and commands; the
[agent operations guide](../data/ingestion-agents.md) owns economical launch/reporting.
The database remains authoritative for work and artifacts; supervisor/intent journals remain
process evidence. The catalog holds expectations, not a duplicate mutable progress ledger.

## Rollout evidence

Original Dyrt run: `4dda8606-9c20-4275-bae6-c14cdea9e38c`.
Original execution: `7561fd60-9f00-4ecd-965c-55b168c53623`.
Original job: `f6c1a95e-7759-4c42-a8dc-a48af1e2d8df`.
Maintenance was entered October 13 at 02:40 UTC; the worker stopped gracefully and discovery
confirmed no workers, processes or source locks. The additive migration
`202610130241__ingestion_record_tasks_and_observability.sql` was applied and schema/generated
artifacts refreshed. Existing observations, normalizations and journals were preserved.

Private baseline and rollout evidence is retained under
`~/.local/state/map-ingestion-audits/2026-10-12-visibility/`. Runtime UUID journals remain under
the primary checkout's ignored `.ingest-jobs` and `.ingest-logs`. Tokens and raw diagnostic
payloads are excluded from this document. Validation and final job receipt will be recorded
here after the bounded checks and restart.

## Improvements to assess from the new metrics

The mocked four-slot test exceeds threefold serial throughput, but production improvement
must be measured under actual quotas. Canonical matching/fusion remains serialized and may
become the next bottleneck. Separating candidate/proposal generation from canonical activation
requires candidate-version checks before adding parallel matching. Model/thinking changes
require a reviewed quality experiment; they are not automatic performance actions.

Source completeness and editorial quality need reviewed current-capture samples. Ten captures
still need classification. Provider fields absent from responses remain unknown, and legacy
standalone workers lack cross-host registration. An advisory next action always rechecks live
admission at launch. No model waits alive to monitor a healthy full import.
