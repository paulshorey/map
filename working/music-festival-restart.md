# Music festival restart — 2026-10-16

Human authorization in owner chat `01a139a6-1dec-73e3-a8fa-46d8c4e14a56`:
review diagnostics, make necessary improvements, run bounded validation, then start
JamBase and That Festival Site with detached supervision if validation succeeds.
The two-hour coordinator may repair routine defects and must stop all ingestion on a
systemic fault, widespread incorrect output or a necessary human review decision.

## Diagnostics and preflight

Merged main `0e2be9e` includes PR47/48/49/50. Acquisition diagnostics retain the caller,
stage, pre/post pool counts, elapsed time, timeout class and 64 recent lifecycle events.
Provider diagnostics distinguish bookkeeping, local HTTP invocation, HTTP response and
result persistence, preserving the original error. These controls are sufficient for
the next bounded experiment; no pool-size, timeout or provider/model change is justified.
Record runtime/dependency versions, safe pool settings and code/source hashes beside each
launch receipt, since historical exited process versions cannot be reconstructed from PIDs.

Primary's dependency links initially lacked pinned `i18n-iso-countries`; the command
failed before database access. Synchronize with the existing frozen lockfile before launch.
No manifest/version upgrade is needed to repair those installed links.

JamBase has 1,257 records. That Festival Site has 1,415 unique natural records, all with
captured venue coordinates. Its city field equals its country field in 104 records; other
country labels include states, and some listing countries disagree with venue geography.
These are split display-location labels, not reliable administrative data. The version-4
source adapter retains city/region/country as `source_location_hints`, retaining the raw
observation, point, source URL, name, natural ID and historical edition fields unchanged.
The existing coordinate lookup supplies standardized administrative fields. This also
allows New Zealand venue coordinates to receive NZ despite a listing hint of Australia.
Optional misses remain explicit rather than inventing a country/address.

The normalization resolver also enforces this source's coordinate-owned administrative
policy. Clearing extractor columns alone is insufficient: a model can copy unreliable
labels back from raw text with evidence paths. Both model and deterministic administrative
proposals stay null until lookup; source street addresses still win. Captured policy
revision 1 changes observation/cache identity so earlier policy artifacts cannot be reused.

Live record 273 exposed a separate output-size failure: GLM echoed the 1,867-artist
lineup into a scalar attribute and both bounded outputs ended with `length`. HTTP
transport succeeded. The source registry now omits only this opaque collection from
model context (raw and captured attributes); its count, identity, venue, dates and
location evidence remain. Full raw/captured lineups stay stored unchanged. The curated
packet changes the normalization cache key, and the failed attempts remain auditable.
This is a diagnosed source repair, not a provider/model or output-budget increase.

PR51 review found that version-2 observations could remain active after a version-3
mapping change because raw JSON alone owned their identity. Observation identity now
also includes a generated hash of captured JSONB and the source POI hint. Raw SHA,
raw observations and prior captured snapshots remain intact; mapping changes create
new observation IDs and refresh staging/normalization, while identical mappings reuse
their existing observation. This migration and its INSERT conflict target must be
deployed together behind maintenance. A real one-record rollback-only PostgreSQL
regression passed the v2-to-v3/same-raw transition, idempotent repeat and changed-hint case.

## Validation and launch gates

- Database-free tests: all original IDs/points/raw values preserved; hints do not become
  authoritative city/country; state names are not countries; unchanged source addresses
  remain preferred. Test registered extractor/version and downstream location behavior.
- Bounded read-only connection matrix, then supervised one-record samples through all
  affected stages: existing JamBase control plus That Festival Site's country-as-city
  and conflicting-country examples. Distinct hypotheses, not a backlog-draining loop.
- Verify HTTP/diagnostic evidence, source fields, point/country/provenance, tasks and zero
  lineage violations. Preserve captured dates/status; they are not promises of availability.
- After successful source acceptance, queue exactly the two approved files with category
  `music_festival`, `--unlimited` and no overall deadline. Run one full process at a time,
  verifying scope completion and process/lock exit before admitting the next file. Ordinary
  Node owns workers, sleep assertions, logs, hourly health checks and terminal receipts.
  One two-hour AI coordinator owns bounded decisions; never keep a model alive waiting.
- A repeated DB failure, provider degradation, lost lock, lineage fault or widespread bad
  output stops all workers/exact supervisors, retains maintenance, pauses the coordinator
  and notifies the human. Do not restart unchanged failures or broaden to other captures.

Exact sample/run/job IDs, quality acceptance, launch receipts and current maintenance state
belong to private `.ingest-jobs/music-restart-20261016T1825/` and automation memory. This
document is the plan; it does not assert successful live validation or full-file completion.

## Matching collision and sequential recovery — 2026-10-16

Both approved files were launched simultaneously at 19:06Z after successful bounded source
validation. At 19:22:11Z That Festival Site's first match collided with the global matching
advisory lock held by JamBase. The process-local `canonicalLane` cannot serialize separate
workers; `pg_try_advisory_lock` intentionally fails fast. The launch strategy missed this
constraint. This failure does not establish a Fireworks outage or recurrence of the earlier
database checkout timeout. The protective lock remains in place.

The Node group watcher detected the terminal failure at 19:22:19Z, requested both exact job
stops, entered maintenance and confirmed quiescence by 19:22:29Z. Both workers, their Node
supervisors and the group watcher exited; both source locks were released. The two-hour
heartbeat was paused for review. Journal timestamps identify JamBase's overlapping match
and the expected fail-fast guard, so the orchestrator can correct this routine launch
coordination error within the standing restart authorization. Unexplained lock conflicts,
provider/database/lineage faults and necessary developer decisions retain the serious
hold rule; the watcher alone cannot authorize a restart.
Original observations, frozen cohorts and successful artifacts remain available:

| Source | Original run | Scope | Committed normalization | Record verification |
| --- | --- | ---: | ---: | ---: |
| JamBase | `227309cd-941e-43ad-a6cc-6281c08aee12` | 1,257 | 50 | 37 |
| That Festival Site | `8eb9009b-f697-4e74-8b84-671128ae742f` | 1,415 | 7 | 0 |

Neither run has whole-file verification. After reconciling the stopped jobs, released locks
and owned maintenance, explicitly reopen admission with that maintenance token before handing
the resume to the approved runner (see the runbook's process-control workflow). Then resume JamBase
with `--resume 227309cd-941e-43ad-a6cc-6281c08aee12 --unlimited` through the approved runner.
Only after verified completion and worker/lock exit, resume That Festival Site with
`--resume 8eb9009b-f697-4e74-8b84-671128ae742f --unlimited`. Use new supervisor job receipts
for resumed executions; the old two-job group watcher must not be restarted with terminal IDs.
No unchanged simultaneous relaunch, model change, pool tuning or source reset is indicated.
Private evidence and terminal-consumption records live in
`.ingest-jobs/music-match-conflict-20261016T1923/`.

## Historical location repair recommendation

Start with a read-only source/category coverage audit. Rebuild canonical administrative
fields from already-linked source/geocode evidence before spending on provider calls.
Next repair missing country values deterministically from unambiguous source evidence;
do not infer a country from a state name. Then perform explicit source-scoped coordinate
enrichment only for remaining gaps, beginning with a small representative cohort.
Prefer captured street addresses, label reverse results approximate, preserve original
observations/attempts/memberships, and report quality/conflicts separately from lineage.
Do not restart the completed Dyrt cohort or trigger an implicit 38k-record reverse sweep.
