# POI capture root migration — 2026-09-27

PR #32 moves discovered capture paths to `data/poi/`. The live inventory had 247
`docs/poi/` rows under the old CHECK constraint. Commit `9633ff8` changed the
repository copy of the already-applied inventory migration to `poi/%`, while the
database retained the executed `docs/poi/%` constraint. The applied migration
file was left intact; its cursor checksum was reconciled from
`37c7a17a2e01e87e54c468c2d3484565f87d740ca7953e2ef5d078ea9adca2b0`
to `37e4cce61fdf4c092e9336b530831dc4530c485fcca7689c61a061b8bfb2b193`.

The forward migration now accepts `docs/poi/%`, `poi/%`, and `data/poi/%` while
retaining the inventory UNIQUE constraint. `db:migrate` applied it, and `db:sync`
regenerated the schema snapshot; the generated types and contracts had no diff.
Inventory refresh discovered 247 files with zero scan errors. The inventory now
has 494 rows: 247 current `data/poi/` paths and 247 historical `docs/poi/` paths
marked missing. This preserves historical rows; it does not reconcile their
identity or progress with the new paths. No ingestion run was started.

`ingest:test-inventory` passed all 6 tests, `check-types` passed, and maintenance
was exited with no workers stopped or left paused.
