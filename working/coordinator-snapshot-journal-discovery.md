# Coordinator snapshot journal discovery

Scope: helper discovery, regression tests, and documentation only. Ingestion remains
paused; this repair does not authorize an import or a change to admission controls.

The primary snapshot failed with exit 78 because `jobs()` validated every immediate
`job.json` parent as a UUID. A preserved named diagnostic packet includes a copied
finished one-record job journal, so it blocked discovery of genuine supervisor jobs.

Discover only UUID-named job directories. Retain strict directory/embedded-ID equality
and parsing failures for those journals. Never promote diagnostic copies by embedded ID,
deduplicate genuine jobs against copies, or use copied terminal evidence for claim release.
Preserve all private packets in place.

Validation: the original eight Python tests pass. Added regressions reproduce the old
snapshot failure and cover diagnostic copies (including malformed copied JSON), genuine
UUID identity mismatches and malformed JSON, unresolved-job admission, and claim retention
when only copied terminal evidence exists. All 13 tests pass with the repair.

Read-only verification at 2026-10-19T18:22:31Z loaded the repaired helper from this worktree
and used the primary checkout's database controls and journals. It found 54 genuine UUID
jobs, all journal-status `finished` (29 succeeded, 11 needs_attention, 12 paused, 2 partial).
Historical terminal outcomes are retained, not reclassified as completion. Controls were
quiescent, maintenance off/token null, with no workers, source locks, admitted workers,
local ingestion scripts, launch claim or intent. Both ingestion heartbeats remained paused.
Before/after checks confirmed 135 evidence/source/schedule files unchanged. The private
snapshot is `/tmp/map-snapshot-discovery-check-20261019.json`; primary source is left
unchanged pending independent review. No imports, provider calls or gate changes occurred.
