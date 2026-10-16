# Database acquisition diagnosis

Owner: native chat `01a14212-df6b-78e0-874d-0091b95e1b32`, 2026-10-15 local.
Scope: diagnose the recurring checkout timeout, preserve failure attribution, validate
at most Taipei + JamBase one-record controls. Full imports and both ingestion
heartbeats remain held. Primary checkout/runtime is unchanged.

## Evidence and confidence

Two historical workers failed with `database_pool_checkout_timeout`:

| Run / execution | Evidence |
| --- | --- |
| Dyrt `4dda8606-9c20-4275-bae6-c14cdea9e38c` / `100267af-d7f3-4a71-b855-d46d01dbc8f9` | 2026-10-14 22:09 UTC; post-error pool max16/total5/idle3. Supervisor's separate probe also hit connection-establishment timeout. This full cohort later completed; never restart it for diagnosis. |
| Taipei `327fc664-1bf1-4e73-b807-7feb78d47f8b` / `484f9fdf-9fe5-41c3-870e-6a756610db4f` | Normalization committed at16:07:03.846 UTC, geocode began16:07:04.283, failure16:07:14.334. Post-error pool max16/total3/idle1; expected source-lock lease. No journaled heartbeat/source-lock failure. |

Taipei provider call `59cdd83a-69e7-4dfb-8b41-48c7e20d090e` was inserted
at16:07:04.691; its call-item link exists, failed completion committed16:07:14.385,
latency9522ms, no HTTP status. Code inspection shows the reverse request's awaited
fetch can rethrow the scheduler's abort reason. The scheduler can abort active work
when its own query/claim fails. This is a supported explanation for the provider row,
not proof of the precise historical checkout caller or remote HTTP delivery. Existing
evidence cannot distinguish its connection/queue trigger. No root cause for the
intermittent database failure is established.

Initial read-only matrix under maintenance: 12/12 acquisitions, max3 simultaneous,
two actual31s idle waits, total64.5s. Direct cold192–334ms, pool cold192–296ms,
warm0–2ms, SELECT43–122ms. All handles/counters zero after closure; max event-loop
delay30.3ms. PostgreSQL18.6 reported9sessions/max500, with8session states hidden
under this role. Earlier190–271ms fresh/138–152ms round-trip probes are a comparison,
not a performance baseline or proof of continuous recovery.

Current Node26.9.0, pg8.21.0, pg-pool3.14.0 match the installed lockfile. The pg
declaration `^8.16.3` permits8.21.0; this is not evidence of dependency drift.
Supervisor launches with its own `process.execPath`; the current executable is the
Homebrew Node26.9.0 binary. Historical exited processes' executable versions cannot
be reconstructed from a saved PID alone. No driver/toolchain/configuration changes.

## Narrow implementation

- Keep original driver errors/codes/causes. Add acquisition start counts, elapsed
  time, caller, operation labels and a bounded64-event lifecycle history. Distinguish
  pending pool timeout from new-client timeout without inferring saturation. Public
  events cannot distinguish DNS/TCP/TLS/authentication subphases.
- Record provider preflight, HTTP invocation/response and terminal-bookkeeping
  boundaries in the private local journal. No SQL/parameters/URLs/keys in this new
  diagnostic data; arbitrary error messages are omitted from lifecycle diagnostics.
- Attempt terminal provider bookkeeping once. A failed UPDATE previously entered
  the adapter's outer catch and attempted another UPDATE, potentially masking the
  first error and counting latency twice. Preserve DB identity and preceding provider
  status instead; reconcile unknown commit outcomes rather than retrying writes.
- Preserve database cancellation identity in forward LocationIQ, matching reverse.
  A systemic abort must not become a retryable provider network error or a miss.
- Keep source-lock lifetime/heartbeat, activation fencing and normal provider
  configuration. Transactions in legacy matching can still span provider work;
  this is documented future work, not evidence explaining the pre-match Taipei fault.

The change is stacked on PR47's compatible location code at4739eda. Do not run
primary's older geocoder against the partial v2 record. No migrations or raw captures
are changed by this diagnosis.

## Validation and recovery gates

Run `ingest:test-database`, `ingest:test-scheduler`, `ingest:test-provider-recovery`,
`ingest:test-llm`, `ingest:test-location`, and `check-types`. The real PostgreSQL
`ingest:test-location:integration <owned-token>` rolls all writes back and mocks
providers. `ingest:database-probe` is fixed read-only scope; see the runbook.

Use NEW supervised cohorts because smoke deliberately rejects resumes. Taipei
selection is `f5e2e5adfc6dfcccd19fa6a1ab04b779663f4297` in
`data/poi/art-fairs/biennials/biennial_association.json`, category `art_fair`.
Reuse accepted normalization, preserve25.0731/121.526, TW/Taipei and captured2023
edition. No invented museum street address. The old partial run remains historical
until a later compatible bounded continuation certifies its own scope.

JamBase control is exact managed key `jambase:16210265` in
`data/poi/music-festivals/apis/jambase_festivals.json`, category `music_festival`.
Its capture supplies both nested venue fields and flat copies. Preserve40.7422/-73.988,
US/New York (NY),11 Madison Avenue,10010,2026-08-07 through2026-08-08. Complete source
fields should need no reverse request. The captured scheduled status is historical.

Both controls require canonical output, exact artifact IDs and zero lineage faults.
One-record success is neither source/category acceptance nor a full-file receipt.
At most60s child deadline +10s termination grace, no global consolidation or chained
samples. A retry needs a new hypothesis/change. Re-enter maintenance before further
runtime edits and before ending; use only the current owned token.

| Result | Next action |
| --- | --- |
| Direct and pooled connection failures recur | Keep serious hold; correlate exact timestamps with owned network/socket phases and read-only server logs. Do not change endpoints/TLS/DNS/capacity or restart infrastructure speculatively. |
| Direct healthy, pool fails | Use origin/label, before/after counts, event ring and leases to reproduce lifecycle/queue/abort defect; narrow regression first. No pool-size/timeout increase as a workaround. |
| Idle reuse alone fails | Verify broken-client eviction and lost source-lock exit; never auto-replace a source lock and continue writing. |
| Provider preflight fails | Request was not invoked through that call. Reconcile partial ledger writes; no provider retry. |
| Response succeeded but bookkeeping fails | Preserve HTTP evidence/unknown commit outcome and stop; reconcile ledger/cache/activation before any repeat. |
| DB checks pass without reproducing | Root cause remains unresolved. Publish measurements/diagnostics, keep full hold and ask for later human-reviewed restart scope. |
| Provider/systemic failure during sample | Stop all samples, restore maintenance, retain partial artifacts/attempts and diagnose that precise fault. |
| Optional404/miss with reliable point | Keep point/source fields and explicit quality gap; verify downstream output rather than invent fields. |
| Country/address/point/lineage mismatch | Stop sample, trace PR47 adapter/cache/activation/provenance; do not exclude data just to pass. |
| Taipei passes, JamBase source control fails | Defer that source/repair adapter; separate source defects from systemic DB health. |
| All checks pass | Review stacked PRs, synchronize compatible runtime deliberately, then obtain the later human full-restart decision. Keep schedules paused meanwhile; That Festival Site still needs its own validation. |

Authoritative references: [pg pool lifecycle](https://node-postgres.com/apis/pool),
[PostgreSQL18 monitoring/visibility](https://www.postgresql.org/docs/18/monitoring-stats.html),
[Node26.9 event-loop measurement](https://nodejs.org/download/release/v26.9.0/docs/api/perf_hooks.html).
Private raw receipts live in primary `.ingest-jobs/database-diagnosis-20261016T0018/`;
tool-owned historical journals remain untouched.
