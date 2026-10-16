# Database acquisition diagnosis

Owner: native chat `01a14212-df6b-78e0-874d-0091b95e1b32`, 2026-10-15 local.
Scope: diagnose the recurring checkout timeout, preserve failure attribution, validate
at most Taipei + JamBase one-record controls. Full imports and both ingestion
heartbeats remain held. Primary checkout/runtime is unchanged.

## Evidence and confidence

Two historical workers failed with `database_pool_checkout_timeout`:

| Run / execution                                                                        | Evidence                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dyrt `4dda8606-9c20-4275-bae6-c14cdea9e38c` / `100267af-d7f3-4a71-b855-d46d01dbc8f9`   | 2026-10-14 22:09 UTC; post-error pool max 16 / total 5 / idle 3. Supervisor's separate probe also hit connection-establishment timeout. This full cohort later completed; never restart it for diagnosis.         |
| Taipei `327fc664-1bf1-4e73-b807-7feb78d47f8b` / `484f9fdf-9fe5-41c3-870e-6a756610db4f` | Normalization committed at 16:07:03.846 UTC, geocode began 16:07:04.283, failure 16:07:14.334. Post-error pool max 16 / total 3 / idle 1; expected source-lock lease. No journaled heartbeat/source-lock failure. |

Taipei provider call `59cdd83a-69e7-4dfb-8b41-48c7e20d090e` was inserted
at 16:07:04.691; its call-item link exists, failed completion committed16:07:14.385,
latency 9,522 ms, no HTTP status. Code inspection shows the reverse request's awaited
fetch can rethrow the scheduler's abort reason. The scheduler can abort active work
when its own query/claim fails. This is a supported explanation for the provider row,
not proof of the precise historical checkout caller or remote HTTP delivery. Existing
evidence cannot distinguish its connection/queue trigger. No root cause for the
intermittent database failure is established.

Initial read-only matrix under maintenance: 12/12 acquisitions, max 3 simultaneous,
two actual 31s idle waits, total 64.5s. Direct cold 192–334ms, pool cold 192–296ms,
warm 0–2ms, SELECT 43–122ms. All handles/counters zero after closure; max event-loop
delay 30.3ms. PostgreSQL 18.6 reported 9 sessions / max 500, with 8 session states hidden
under this role. Earlier 190–271ms fresh/138–152ms round-trip probes are a comparison,
not a performance baseline or proof of continuous recovery.

Current Node 26.9.0, pg 8.21.0, pg-pool 3.14.0 match the installed lockfile. The pg
declaration `^8.16.3` permits 8.21.0; this is not evidence of dependency drift.
Supervisor launches with its own `process.execPath`; the current executable is the
Homebrew Node 26.9.0 binary. Historical exited processes' executable versions cannot
be reconstructed from a saved PID alone. No driver/toolchain/configuration changes.

## Narrow implementation

- Keep original driver errors/codes/causes. Add acquisition start counts, elapsed
  time, caller, operation labels and a bounded 64-event lifecycle history. Distinguish
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

The change is stacked on PR47's compatible location code at 4739eda. Do not run
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
Reuse accepted normalization, preserve 25.0731/121.526, TW/Taipei and captured 2023
edition. No invented museum street address. The old partial run remains historical
until a later compatible bounded continuation certifies its own scope.

JamBase control is exact managed key `jambase:16210265` in
`data/poi/music-festivals/apis/jambase_festivals.json`, category `music_festival`.
Its capture supplies both nested venue fields and flat copies. Preserve 40.7422/-73.988,
US/New York (NY), 11 Madison Avenue, 10010, 2026-08-07 through2026-08-08. Complete source
fields should need no reverse request. The captured scheduled status is historical.

Both controls require canonical output, exact artifact IDs and zero lineage faults.
One-record success is neither source/category acceptance nor a full-file receipt.
At most 60s child deadline + 10s termination grace, no global consolidation or chained
samples. A retry needs a new hypothesis/change. Re-enter maintenance before further
runtime edits and before ending; use only the current owned token.

| Result                                      | Next action                                                                                                                                                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Direct and pooled connection failures recur | Keep serious hold; correlate exact timestamps with owned network/socket phases and read-only server logs. Do not change endpoints/TLS/DNS/capacity or restart infrastructure speculatively.             |
| Direct healthy, pool fails                  | Use origin/label, before/after counts, event ring and leases to reproduce lifecycle/queue/abort defect; narrow regression first. No pool-size/timeout increase as a workaround.                         |
| Idle reuse alone fails                      | Verify broken-client eviction and lost source-lock exit; never auto-replace a source lock and continue writing.                                                                                         |
| Provider preflight fails                    | Request was not invoked through that call. Reconcile partial ledger writes; no provider retry.                                                                                                          |
| Response succeeded but bookkeeping fails    | Preserve HTTP evidence/unknown commit outcome and stop; reconcile ledger/cache/activation before any repeat.                                                                                            |
| DB checks pass without reproducing          | Root cause remains unresolved. Publish measurements/diagnostics, keep full hold and ask for later human-reviewed restart scope.                                                                         |
| Provider/systemic failure during sample     | Stop all samples, restore maintenance, retain partial artifacts/attempts and diagnose that precise fault.                                                                                               |
| Optional404/miss with reliable point        | Keep point/source fields and explicit quality gap; verify downstream output rather than invent fields.                                                                                                  |
| Country/address/point/lineage mismatch      | Stop sample, trace PR47 adapter/cache/activation/provenance; do not exclude data just to pass.                                                                                                          |
| Taipei passes, JamBase source control fails | Defer that source/repair adapter; separate source defects from systemic DB health.                                                                                                                      |
| All checks pass                             | Review stacked PRs, synchronize compatible runtime deliberately, then obtain the later human full-restart decision. Keep schedules paused meanwhile; That Festival Site still needs its own validation. |

Authoritative references: [pg pool lifecycle](https://node-postgres.com/apis/pool),
[PostgreSQL18 monitoring/visibility](https://www.postgresql.org/docs/18/monitoring-stats.html),
[Node26.9 event-loop measurement](https://nodejs.org/download/release/v26.9.0/docs/api/perf_hooks.html).
Private raw receipts live in primary `.ingest-jobs/database-diagnosis-20261016T0018/`;
tool-owned historical journals remain untouched.

## Completed bounded validation

Implementation PR: [draft #48](https://github.com/paulshorey/map/pull/48), stacked on
[draft #47](https://github.com/paulshorey/map/pull/47). Runtime tested at ba3ad91.
No full files launched; primary remains clean main f2f68c8.

| Control                                     | Exact receipt                                                                                                                            | Result                                                                                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Taipei, one existing record, geocode onward | Run `5fffabf0-13dc-456e-8e96-39b2c0e2a4e7`; execution `8910090d-29f2-47fe-83f9-f943217bb4a7`; job `228f8613-5bae-456c-8da9-a8bad2273ce0` | Succeeded/verified 00:31:44 UTC; 19.1s execution, no forced stop or errors. Accepted normalization f9957a37 reused; fresh reverse HTTP 200 / 458ms, 0 cache hits, fresh Jina embedding and GLM match.         |
| JamBase, one fresh record                   | Run `2b93f890-cce7-4816-ba54-c71eeb150c5e`; execution `425ccd3a-2ab2-4cc1-93de-c3e06914d2fd`; job `bbb3cded-1786-432c-9265-8b4e62086e0f` | Succeeded/verified 00:32:49 UTC; 25.2s execution, no forced stop/errors. Fresh GLM normalization HTTP 200 / 6,484ms, fresh Jina embedding, deterministic matching. 0 geocoder calls; lookup_state=not_needed. |

Both record verification and global lineage verification passed with 0 violations.
No checkout/query/heartbeat/source-lock failures, provider retries or recovery events.
Every measured stage's aggregate database time was under 2.2s; no 10s checkout timeout
occurred. These observations are bounded to the samples and do not establish uptime.

Taipei artifact e3387618 binds the exact accepted normalization/point; live response
cache exists. The inferred road was 95.6m from the anchor and labelled reverse_geocode;
region remains null with location_fields_incomplete. Canonical a26d66ce remains the
same, has both active source memberships, preserves the other source's supplied
museum address and 2023-11-18 through2024-03-24 edition. No invented street replaces
that source address. JamBase canonical 239f824a retains exact source point/address,
US/New York, postal 10010, raw venue NY and day-precision 2026-08-07/08 dates.

The old failed Taipei run 327fc664 remains failed/verified_at=null as historical
evidence. Its selected record is now repaired and certified by the new bounded run;
do not restart a completed full cohort or rewrite old errors to make history green.
The new run verifies its requested suffix, with the accepted normalization reused;
it did not send Taipei through a fresh LLM normalization.

Source-wide status after the samples: Biennial Association 41 rows / 41 linked / 0 match-ready;
JamBase 1 row / 1 linked / 0 match-ready out of 1,257 captured events. Only the named records
received this location validation. No claim of category completion or whole-file
v2 quality acceptance. That Festival Site still has no live sample/full-run proof.

New recorded Fireworks estimates total $0.0012710625 ($0.0002080625 Taipei match,
$0.001063 JamBase normalization). Both requested GLM 5.3 Flash Priority; returned tier
was absent. Two Jina requests and one LocationIQ request have unknown prices in
the ledger. Historical normalization spend is separate. All 5 observed calls HTTP 200.

Second, instrumented connection matrix: 12/12 passed in 64.4s. Fresh direct 193–302ms,
pool cold 187–261ms, warm 0–1ms; final pool/direct/lease counts all 0. Max event-loop
delay 32.7ms. Together the two matrices cover 24 acquisitions, not sustained load.

A separate local TCP fixture that never answered PostgreSQL startup exercised the
probe's connection-failure cleanup with the real 10s timeout. It exited in 10.2s,
retained failure status, and closed every pool/direct/leased handle. It called no
real database or provider. Pool shutdown is shared between deadline/finally, and
late acquisitions cannot issue another diagnostic query after expiry.

Final maintenance was restored 00:33:19 UTC, quiescent with no workers, locks,
admitted workers or local ingestion scripts. The new current token is in private
maintenance-restored.json and both automation memories; the transferred old token
was deliberately released for the two samples and is obsolete. Both ingestion
heartbeats remain PAUSED. Full restart is still a later human review/decision.

Next read-only checks from primary and the compatible diagnostic checkout:

```sh
pnpm --silent --filter @lib/db-map ingest:control list --json
pnpm --silent --filter @lib/db-map ingest:status --run 5fffabf0-13dc-456e-8e96-39b2c0e2a4e7 --json --limit 10
pnpm --silent --filter @lib/db-map ingest:status --run 2b93f890-cce7-4816-ba54-c71eeb150c5e --json --limit 10
```

The exact tested one-record commands are retained in each job.json. After review,
the human can choose a further owned one-record window with the new diagnostics,
or extended read-only network/server correlation. Stop at the first database/query/
source-lock fault, exhausted provider recovery or output/lineage error; preserve
the exact IDs and return to maintenance. Do not automatically unpause, launch full
files, or repeat these now-warm samples as proof of fresh-provider reliability.

## Independent review synchronization — 2026-10-16

PR #47 and checkpoint repair PR #49 are now merged into `main`. The diagnostic
branch still targeted the old location feature branch. A separate review fix
merges current `main` into the diagnostic branch, retaining its provider lifecycle
markers and abort-reason preservation while taking main's region invalidation,
downstream checkpoint requeue, and location resume tests. The old location rollout
notes remain historical. No operational maintenance state or schedule was changed.

The fix targets the original diagnostic branch for independent review; after that
fix is merged, retarget PR #48 to `main` and review the resulting diagnostic-only
diff. The intermittent connection failure remains unexplained; the diagnostics
are observability changes, not evidence that a sustained import is safe to restart.
