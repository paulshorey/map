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
These are split display-location labels, not reliable administrative data. The version-3
source adapter retains city/region/country as `source_location_hints`, retaining the raw
observation, point, source URL, name, natural ID and historical edition fields unchanged.
The existing coordinate lookup supplies standardized administrative fields. This also
allows New Zealand venue coordinates to receive NZ despite a listing hint of Australia.
Optional misses remain explicit rather than inventing a country/address.

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
- After successful source acceptance, launch exactly the two approved files with category
  `music_festival`, `--unlimited`, distinct source locks and no overall deadline. Ordinary
  Node owns workers, sleep assertions, logs, hourly health checks and terminal receipts.
  One two-hour AI coordinator owns bounded decisions; never keep a model alive waiting.
- A repeated DB failure, provider degradation, lost lock, lineage fault or widespread bad
  output stops all workers/exact supervisors, retains maintenance, pauses the coordinator
  and notifies the human. Do not restart unchanged failures or broaden to other captures.

Exact sample/run/job IDs, quality acceptance, launch receipts and current maintenance state
belong to private `.ingest-jobs/music-restart-20261016T1825/` and automation memory. This
document is the plan; it does not assert successful live validation or full-file completion.

## Historical location repair recommendation

Start with a read-only source/category coverage audit. Rebuild canonical administrative
fields from already-linked source/geocode evidence before spending on provider calls.
Next repair missing country values deterministically from unambiguous source evidence;
do not infer a country from a state name. Then perform explicit source-scoped coordinate
enrichment only for remaining gaps, beginning with a small representative cohort.
Prefer captured street addresses, label reverse results approximate, preserve original
observations/attempts/memberships, and report quality/conflicts separately from lineage.
Do not restart the completed Dyrt cohort or trigger an implicit 38k-record reverse sweep.
