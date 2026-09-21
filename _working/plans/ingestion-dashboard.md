# File inventory and ingestion dashboard

## Outcome

Give the human operator and AI engineer one reliable answer to: which source files exist,
which version was processed, what remains, where work stopped, and what command to run next.
Long ingestion remains a manually launched terminal process. The dashboard never launches it.

## Implementation

1. **Inventory independent of ingestion.** Add a database table for discovered paths under
   `poi`, current SHA-256, size, modification/discovery/scan times, missing-file state,
   source/category configuration, disposition, priority, and operator notes. Preserve file
   hash history and edits. Discover JSON/JSONL/CSV/KML/KMZ, including unregistered files;
   do not interpret every JSON file as an import. Use registered categories or historical
   explicit run categories when available; otherwise require an operator selection.
   Hash streams without provider calls, detect files changing during scan, and serialize
   inventory refreshes. Never retire database ingestion data when a file disappears.
2. **One shared assessment.** Implement database queries and typed completion logic in
   `@lib/db-map`. Assess the current file hash and extractor version; deduplicate record
   evidence across retries/runs. Keep coverage, execution, and freshness separate. Complete
   requires complete extraction, valid required record outputs, and verification evidence
   covering those outputs. Samples cannot certify a whole file. Unknown totals stay unknown.
   Include stage counts, exclusions, blockers, latest execution, last committed work, costs,
   and exact safe shell commands. Preserve legacy/changed/missing distinctions.
3. **Agent/operator CLI.** Add `ingest:inventory` to refresh discovery and display the same
   assessments as the app, with JSON output and per-file detail. Reuse existing run status,
   record trace, and pause behavior instead of creating another execution engine.
4. **Local dashboard app.** Add `apps/ingestion`, served on loopback separately from the
   public map app. Show searchable/filterable files, category totals, work queue, stage
   counts, and last activity. File detail shows versions, executions, unresolved attempts,
   provider metrics, and commands. Support notes, explicit category/disposition/priority,
   and graceful pause. Refresh while open without overwriting unsaved edits. Escape source
   text, protect mutation requests from cross-origin access, and keep credentials server-side.
5. **Documentation.** Add app setup and architecture notes; link the human README and
   shared runbook to inventory/dashboard operation and explain completion limitations.
6. **Validation.** Apply migration with `db:sync`; check generated contracts/types. Test
   completion edge cases, sample-vs-file coverage, changed/deleted files, retained notes,
   scan failure behavior, and API input/origin handling. Run the scanner on real files and
   compare the dashboard with database evidence. Inspect the live UI and its main controls.

## Deliberate boundaries

- No ingestion scheduler, background full imports, or provider calls during discovery.
- No automatic assumption that alternate CSV/JSON exports are different datasets or identical.
- Structural verification is separate from editorial/geographic quality approval.
- Legacy imports without file provenance remain unknown rather than being guessed complete.
- Alerts outside the open dashboard and batching/concurrency improvements are follow-up work.

## Delivery evidence

Implemented all six steps. The app runs at `http://127.0.0.1:5001` using
`pnpm dev:ingestion`; its server honors the workspace's port configuration.

- Migration `202609201443__ingestion_inventory.sql` applied with `db:sync`; schema snapshot,
  TypeScript types and database contract regenerated. No source ingestion data reset.
- Live discovery: 247 source-file candidates, 43 configured for import from existing explicit
  metadata, 204 needing review. Four files have tracked ingestion history. At validation time,
  two were partial and two had outputs ready for verification; no whole file was certified complete.
- Shared CLI/API assessment joins file hashes/extractor/category, distinct extraction records,
  current artifacts, active memberships/build inputs and verified scopes. It reports unknown
  totals honestly and includes excluded/degraded records separately.
- Local dashboard includes search, category/disposition/work filters, stage counts, file versions,
  run/attempt inspection, provider and stage metrics, exact commands, pause, priorities, and notes.
  Notes have edit history, conflict checks, and survive background refreshes and rescans.
- `pnpm --filter @lib/db-map check-types` and `pnpm --filter @app/ingestion check-types` pass.
- Five inventory/assessment/discovery unit tests and two HTTP authorization unit tests pass.
- `ingest:test-inventory:integration` passes against two isolated non-POI fixture records:
  sample vs whole-file completion, retries without double-counting, stale outputs, changed/missing
  files, retained notes, explicitly cleared category, and edit conflicts. Fixtures were removed.
- HTTP checks passed for persistent edits, stale-edit rejection, invalid pause, origin checks,
  static asset confinement, and absence of a launch endpoint.
- Browser inspection verified real-file search, stage/run error detail, notes surviving refresh,
  saving classification/notes and reopening them. The UI validation fixture was removed.

Remaining boundaries are deliberate: scan after changing captures; historical evidence without
provenance is not guessed; metrics cover attributed normalization and audited attempts; full runs
stay in the terminal; completion is structural and does not substitute for quality review.
