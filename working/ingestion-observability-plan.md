# Ingestion observability implementation

Status: implemented, validated and running the repaired original full Dyrt cohort (October 12, 2026).
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

## October 12 startup handoff

The final one-record managed smoke succeeded (run `4a2af2de-b61d-4fce-9a8f-1402613e1e98`,
execution `33ab6758-5f52-4d7a-a08a-d74e0ddb98ac`, job
`880b9fc2-f06b-4146-b64d-e9c5a020ab17`) with zero normalization requests and all stages verified.

Full original run `4dda8606-9c20-4275-bae6-c14cdea9e38c` was then resumed on the repaired
implementation (`eb13275`) through the configured cheap launcher. Final job:
`008eba39-a370-4369-a506-8c1e7b360832`; execution:
`3c766665-ac68-4d0c-b992-545e96b10429`. Original cohort/options/checkpoints were preserved,
with explicit `--unlimited --llm-concurrency 4`, no overall deadline and hourly ordinary Node
health checks. Maintenance is open. The callback route passed preflight; the deliberately stopped
first startup also produced a durable accepted terminal delivery receipt to the current parent.
This establishes transport acceptance, not a guarantee of immediate client consumption.

At 04:37 UTC on October 13, the shared snapshot showed a live worker/source lock, 33 active
record tasks, 1,120 successful embedding tasks and 33 successful verification tasks, plus 36 Jina
calls averaging 32 records each with zero failures. Browser inspection at approximately 04:41 UTC
showed 3,746 completed embedding tasks and 120 completed verification tasks. These are dated
startup observations, not a maintained progress ledger or whole-file completion proof.
Normalization is held by backpressure while the adopted 16,873-record downstream frontier drains;
its shared four-slot admission becomes available as that frontier falls below the low watermark.

The next action is to preserve this progressing worker. Use the shared overview/doctor for fresh
state and the existing supervisor stop/control procedures for intervention. The two legacy
failed/stale normalization outputs remain visible and are eligible for managed repair; ten files
still need classification and category quality is not accepted. Canonical matching/dispatch
round trips are the next performance candidates. Provider/database stage timing and throughput
must be compared before changing canonical serialization or quality settings.

Journal: `lib/db-map/.ingest-logs/4dda8606-9c20-4275-bae6-c14cdea9e38c-3c766665-ac68-4d0c-b992-545e96b10429.jsonl`.
Durable job/result directory: `lib/db-map/.ingest-jobs/008eba39-a370-4369-a506-8c1e7b360832/`.
The primary checkout stays on the implementation PR branch; `main` has not been merged.

## October 13 scheduler exit repair

Job `008eba39-a370-4369-a506-8c1e7b360832`, execution
`3c766665-ac68-4d0c-b992-545e96b10429`, stopped at 05:00 UTC during scope verification.
It retained 16,820 successful embedding tasks, 516 successful matching tasks and 515
successful record verifications, with zero new normalization requests. The listed incomplete
records already had valid normalization/embedding artifacts and were waiting for matching.
Record 938's match committed while its canonical/verification tasks remained pending.
Read-only diagnosis found 16,356 immediately ready matches and 26,399 normalization tasks.

The scheduler checked its completion revision only when promises remained active. If the last
match finished during a later claim query, the reverse dependency pass had already missed the
newly unlocked work and the empty promise set caused premature exit. The exact ordering is
reproduced by a regression test that failed on the prior implementation. Completion revision
now takes precedence over an empty active set; a stable idle pass additionally checks durable
selected task counts and raises `scheduler_stalled` for unfinished eligible work. Quarantined
and operator-excluded records, deliberate stop points and provider-budget pauses retain their
own semantics. Global verification remains required.

Maintenance was entered after fresh discovery confirmed process/lock quiescence. Journals,
successful outputs and the original 43,272-record scope are retained. No data reset or schema
change is needed. Validation and the next delegated receipt will be recorded below.

All 16 scheduler/concurrency/embedding/telemetry tests and the database type/contract checks
passed. A one-record rollback-only real PostgreSQL check verified unfinished counts, selected
stage bounds and quarantine/operator-exclusion handling; its full-cohort query took 87 ms.
All diagnostic mutations rolled back. No schema changes were made.

One-record managed smoke selected source record 939 and succeeded through every stage, report
and global lineage verification: run `cae432e8-920d-4ea0-b3ea-bfb958457b2e`, execution
`58ab7e6d-4157-40fa-9ed3-08c0e52e78f2`, job `d0e345e0-af43-4efe-b077-e26618e369b4`.
It made one normalization request costing $0.0038505, reused source coordinates and completed
embedding/matching/canonical verification. Its `verified_at` is 2026-10-13T05:08:43.007Z.
This sample validates the repaired path; it does not establish whole-file completion.
Maintenance was reopened with the owned token for validation. The parent notification probe
is ready using the matching installed Codex CLI. The next launch remains delegated.

The configured cheap launcher acknowledged the repaired full resume on `f016449`: job
`10294406-7958-43e2-a932-7bbcdbc0f20f`, execution
`05da7235-9b09-4d25-8f19-37d9e32dec04`, original run
`4dda8606-9c20-4275-bae6-c14cdea9e38c`. Its admission reconciliation confirmed an open gate,
quiescence and no unresolved worker/lock/claim. It used `--unlimited --llm-concurrency 4`,
preserving the original cohort/options and remaining checkpoints. Node owns hourly checks and
terminal delivery; no model remains alive to watch progress. This is a launch acknowledgement,
not whole-file completion. No additional full run was started by the coding agent.

Journal: `lib/db-map/.ingest-logs/4dda8606-9c20-4275-bae6-c14cdea9e38c-05da7235-9b09-4d25-8f19-37d9e32dec04.jsonl`.
Job/result directory: `lib/db-map/.ingest-jobs/10294406-7958-43e2-a932-7bbcdbc0f20f/`.
Private launch receipt: `/tmp/map-ingestion-failure-008eba39-resume-receipt.json`.

## October 13 database timeout diagnosis

Execution `05da7235-9b09-4d25-8f19-37d9e32dec04` / job
`10294406-7958-43e2-a932-7bbcdbc0f20f` stopped at 08:22:58 UTC after substantial matching
progress. Durable task totals include 5,151 successful and eight reused matches, 5,159 successful
canonical/record verification tasks and 16,819 successful embeddings. This execution made zero
normalization requests while downstream backpressure held admission; it did make 77 successful
Fireworks matching calls. Whole-file verification remains absent.

The exact last failed unit was matching record 20908, not normalization. The terminal
`current_stage=normalize` identifies the earliest unfinished cohort stage. The fatal error
message is emitted by the installed pg-pool 3.14.0 checkout queue, not its new-connection path.
Scheduler failure aborted the concurrent matching fetch with the database Error as its reason;
the old LLM catch relabeled it retryable "Network error". The actual occupancy/leak/lock/network
cause is unproven because the old process did not retain pool evidence. Current read-only
diagnostics succeeded (nine server connections against max_connections=500, one active).

Fresh discovery confirmed no workers, locks or launch claims. A concurrent independent review
task briefly owned maintenance, then verified clean checkouts/no runtime writes and released
its own gate. This chat entered its own gate before changes; other-task evidence and journals
were preserved. No data reset, schema change or full launch was performed during diagnosis.

Database query/checkout failures now preserve bounded pool/holder diagnostics and the exact
checkout error code. Source-lock leases are labeled and released/removed leases are discarded.
Systemic cancellation preserves its original error through the provider layer. Terminal evidence
includes the structured execution error and clarifies current-stage versus failed-attempt meaning.
This adds missing diagnostic evidence; it does not claim to have established the historical
pool occupancy cause or add speculative database retries/capacity changes.

The real pg-pool offline saturation test verifies checkout timeout, promise/callback handling,
holder identities, release/reuse and omission of SQL/parameters. Mocked provider tests verify
database-triggered cancellation is systemic and independent socket errors remain recoverable.
The affected-record live validation and next delegated receipt will be recorded below.

Validation passed: 17 scheduler/concurrency/embedding/telemetry tests, 13 LLM tests, 12 provider
recovery tests, 27 supervisor/notification/control-option tests and database type/contract checks.
The old terminal evidence was read through the updated collector: it correctly shows
`execution_error` as the database timeout, actual failed matching record 20908 and absent
historical pool metadata. This does not retrospectively fabricate missing evidence.

The bounded managed smoke started at matching for record 20908, retaining its upstream
normalization/coordinates/embedding. It succeeded through matching, canonical and record/global
verification plus reporting: run `1b52dfd8-6161-42cd-8a56-090280d27977`, execution
`756c46cb-6fe7-4764-9735-9410ae710e50`, job `6ee6396c-6453-4c89-99ab-a316741fa009`,
verified at 2026-10-13T12:56:28.872Z. One successful Fireworks matching request cost $0.0017199;
no normalization, geocoding or embedding provider work was needed. Current database reads and
the affected provider path are available; no persistent capacity fault was observed. A checkpoint
resume of the original full cohort is the reviewed next action, with improved evidence if the
unproven historical occupancy problem recurs. Maintenance was reopened with this chat's token,
and the original parent's matching CLI/daemon notification probe is ready.
