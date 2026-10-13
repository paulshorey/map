# Ingestion observability implementation

Status: implemented and validated; original full Dyrt resume pending final launch receipt (October 12, 2026).
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
`202610130241__ingestion_record_tasks_and_observability.sql` and forward-only recent-history index
migration `202610130409__ingestion_provider_history_lookup.sql` were applied and schema/generated
artifacts refreshed. Existing observations, normalizations and journals were preserved.

Private baseline and rollout evidence is retained under
`~/.local/state/map-ingestion-audits/2026-10-12-visibility/`. Runtime UUID journals remain under
the primary checkout's ignored `.ingest-jobs` and `.ingest-logs`. Tokens and raw diagnostic
payloads are excluded from this document. Validation completed: package/app typechecks and app contract drift checks; 13 scheduler,
14 inventory/overview, 11 LLM, 12 recovery, four control, 27 supervisor and two app tests;
eight coordinator tests; live JSON Schema validation (including unsafe unknown-state rejection).
The isolated two-record integration passed real SQL task dependency/fencing/rollback and advisory
lock compatibility, stale/changed/missing files, audited classification and full-file proof.
All fixture data was removed by its scoped cleanup.

Live unchanged-model shadow: run `24b247d7-28f6-4074-acad-d20468e1d19a`, execution
`795bf3ee-b9a7-43f3-aa9f-52cd60e70bfb`, job `2aeffa4c-671d-4b8a-a64e-80f9f42dc50b`.
Three normalizations overlapped for approximately 24.3 seconds versus 67.0 seconds of summed
provider latency, with zero failures and $0.0114471 known cost. Shadow output was not activated;
its intentional paused outcome does not certify downstream completion.

Live end-to-end selection: run `37fc653b-2e37-4acf-a0e5-d514107fa3fb`, execution
`dec5edb7-2a3d-4f9a-afa7-23e1017f2393`, job `93d9ef18-3506-4301-bb98-e26f76616c61`.
All three records finished all stages, report and global lineage verification. Three normalization
calls cost $0.009190248; Jina made two calls for three embeddings, including a two-record batch.
Jina cost was not supplied and stays unknown. The coordinate reuse path was exercised; no live
LocationIQ request or matching/fusion LLM call was needed for these records. Database metrics
now include callback and promise paths without double counting. These are bounded validations,
not whole-file completion. The matching installed Codex CLI 0.155.1 was verified against its
running daemon for terminal delivery; the auto-updated default CLI 0.162.1 mismatched that daemon.
The launcher uses an explicit process environment override without restarting unrelated tasks.

The dashboard API and live browser inspection show all 247 files, 156 unstarted intended imports,
77 supporting/excluded captures, classification review, scan/database ages and quality flags.
A one-record rollback-only live integration also proved linked embedding/geocode activation
rebuilds canonical inputs atomically without provider calls or retained changes.
The final launch receipt will be recorded after restart.

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

## Full-cohort startup correction

The first full restart (job `66286f43-b797-4585-af94-e495e34a0d58`, execution
`028ea493-8869-4a19-ae46-cb8432302ff9`) exposed a poor PostgreSQL plan for the correlated
backlog count on 259,632 newly seeded tasks. It admitted no records and made zero new
normalization requests. Maintenance requested its stop; the exact identified read-only query
was cancelled after 353 seconds, and process/lock quiescence was confirmed. Diagnostic evidence,
terminal result and callback receipt were retained. No successful artifacts were reset.

The scheduler now builds its committed frontier with one grouped pass, then maintains a set of
record IDs as stage outcomes arrive. Completion ordering cannot produce phantom backpressure;
normalize-only selections do not depend on a later verification stage. The real 43,272-record
frontier scan took 559 ms including connection/transfer; six rollback-only real claim checks took
148–262 ms each. Thirteen scheduler/telemetry tests include large adopted frontiers and early
artifact commit versus late handler return. The final smoke and resumed job receipt follow below.
