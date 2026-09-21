# Ingestion dashboard

A local operations app for the source files in `poi`. Uses the existing shell's
`DB_MAP_URL`; no `.env` file or browser-visible database credentials.

```bash
# Repository root
pnpm --filter @lib/db-map db:sync
pnpm --filter @lib/db-map ingest:inventory --refresh
pnpm dev:ingestion
```

Open **http://127.0.0.1:5001**. `PORT` or `INGESTION_DASHBOARD_PORT` overrides the port.
The server binds only to loopback. Keep it local; this is not an authenticated hosted admin app.

The inventory persists file hashes/history, missing files, classifications, notes and priorities.
A scan streams and hashes JSON/JSONL/CSV/KML/KMZ files, without parsing all their records,
calling providers, or launching ingestion. A failed directory traversal does not mark files
missing. Symlinks are not followed. Scan errors are visible per file. Scans are serialized.
This inventory represents the checkout that was last scanned; scan again after switching
checkouts, pulling new captures, or changing files. Database progress refreshes every ten seconds.

Use **Needs review** to assign explicit categories and classify supporting files or alternate
exports before processing. Notes are required when excluding a file from the import queue.
Categories come from existing explicit ingestion metadata or registered source configuration;
folder names do not silently choose categories. Alternate exports are not automatically equated.

Use a file's drawer to inspect runs, stage attempts, errors, artifact IDs, provider metrics,
file history, and operator edits. Copy commands into a terminal at the repository root.
The dashboard can request a graceful pause; it never starts/resumes long work itself.
Run details are bounded snapshots; select Inspect again or Refresh status for fresh attempt
samples. Draft notes survive background status refreshes. Use Discard draft to close without saving.
Conflicting saves from another session are rejected; reopen the file and merge the notes.

## Completion semantics

The shared query in `lib/db-map/sql/ingestion-inventory.ts` is used by the UI and CLI.

- **Unstarted:** no extraction version matches the current content hash, extractor and category.
  A changed file can have older successful runs; those do not certify the current version.
- **Partial:** extraction is incomplete or required current outputs are missing. A successful
  sample remains partial. Empty extractions require review, not an automatic complete label.
- **Ready to verify:** full extraction and valid current outputs exist, but verification evidence
  does not cover every distinct record. Copy the `--from report` command to verify existing output.
- **Complete:** full extraction, valid current required outputs, and verification covering every
  distinct record under current pipeline versions. Evidence may come from multiple successful runs.
- **Unknown:** unsupported format, failed scan, or unavailable content fingerprint.

Readiness checks observation identity/retirement, active normalization, coordinates, embedding
lineage, membership and canonical build inputs. Intentional non-POIs count as excluded terminal
records; degraded normalization remains visible. Changed artifact activation times invalidate old
verification. Category totals count inventoried files, including unclassified/ignored files;
these are inventory totals, not a claim of category quality or expected-source completeness.

Coverage, execution and freshness are separate: a missing file retains its processing history;
a failed latest run does not erase prior valid outputs; stale heartbeats only suggest interruption.
The total stays unknown until full extraction. Source row count may differ from distinct record
count because repeated source IDs are deduplicated. Hash and history are evaluated only as of the
last scan; live database evidence is refreshed separately.

## CLI and checks

```bash
pnpm --filter @lib/db-map ingest:inventory --json
pnpm --filter @lib/db-map ingest:inventory --file poi/rv_campgrounds_data/thedyrt/rv_campgrounds.csv --json
pnpm --filter @lib/db-map ingest:test-inventory
pnpm --filter @lib/db-map ingest:test-inventory:integration
pnpm --filter @app/ingestion check-types
pnpm --filter @app/ingestion test
```

The integration test writes two isolated non-POI fixture records, scans the checkout, and removes
its own fixtures. It calls no providers. Provider metrics in the UI cover attributed normalization
requests; legacy calls and matching/fusion costs are not included. There is no scheduler or alert
delivery while the app is closed. See the [shared runbook](../../poi-ingestion.md).
