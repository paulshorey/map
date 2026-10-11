# POI capture root migration — 2026-09-27

PR #32 moves discovered capture paths to `data/poi/`. The live inventory had 247
`docs/poi/` rows under the old CHECK constraint. Commit `9633ff8` changed the
repository copy of the already-applied inventory migration to `poi/%`, while the
database retained the executed `docs/poi/%` constraint. The applied migration
file was left intact; its cursor checksum was reconciled from
`37c7a17a2e01e87e54c468c2d3484565f87d740ca7953e2ef5d078ea9adca2b0`
to `37e4cce61fdf4c092e9336b530831dc4530c485fcca7689c61a061b8bfb2b193`.
The shared database is reconciled. Another already-migrated database with a
different cursor checksum needs its own schema/cursor inspection before running
`db:migrate`; the migration runner correctly rejects an unverified mismatch.

The first forward migration accepted `docs/poi/%`, `poi/%`, and `data/poi/%` while
retaining the inventory UNIQUE constraint. Inventory refresh discovered 247 files
with zero scan errors, but created 247 new rows beside the 247 historical rows.
Because inventory assessment joins source history by exact logical path, this
initially hid prior progress on the current paths and prevented old runs from
resuming against their saved file paths.

The follow-up `202609280536__reconcile_poi_capture_paths.sql` moves the original
inventory and source-file identities to `data/poi/`. It checks for path collisions
and conflicting metadata before merging duplicate inventory rows, versions and
operator edits. The run's original `options.file` remains historical evidence;
resume resolves through the source file's current logical path. The follow-up
was tested in a transaction and rolled back before being applied with `db:sync`.
Affected inventory, version, edit and source-file metadata was exported locally
to `/tmp/poi-pr32-reconciliation-before.jsonl` before the repair.

After application, inventory has 247 current rows and zero missing old paths.
All 247 original inventory IDs and four original source-file IDs were preserved,
with four source-file versions and all 15 runs still linked. The TheDyrt file's
43,272 extracted records appear under its current path with a resume command.
No ingestion backlog was started or restarted by the migration.

Validation: `db:sync`, `check-types`, all six inventory unit tests, all eight
extractor smoke cases, and the two-record inventory integration fixture passed.
The fixture resumed a run whose saved `options.file` was changed to a legacy
`docs/poi/` path, reused its existing checkpoints, and made no provider requests.
A read-only dry-run resume of the existing TheDyrt run resolved the current path
and unchanged file hash. After validation, the fixture source and file were
removed, the maintenance gate was reopened, and process control showed no
workers or locks. The previously paused production-data runs were not resumed.
