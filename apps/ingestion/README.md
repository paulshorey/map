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
The dashboard supports iframe previews, including the local-dev Apps view. Its CSP restricts
scripts, styles and API connections to the dashboard's own origin and permits trusted parent
frames as described below. API requests still require the dashboard's exact local Host and same-origin checks;
mutations also require JSON and the dashboard client header. Reload the parent page after
changing preview settings so its frame policy includes the dashboard address.

Iframe previews allow same-origin and HTTP loopback parents (`127.0.0.1` and `localhost`)
on any port, including local-dev at port 8000. Other sites cannot frame the dashboard.
Loopback ports remain flexible for local controllers and compatible with local-dev's framing
probe. The Host/origin checks and JSON mutation requirements still apply inside an iframe.
To trust another controller, set `INGESTION_FRAME_ORIGINS` to a whitespace-separated list of
exact HTTP(S) origins before starting the dashboard; for example,
`https://pauls-macbook-pro.taila9173b.ts.net:8000`. Wildcards, credentials, paths, queries and
fragments are rejected at startup. Do not use a whole-tailnet wildcard.
The current local-dev ingestion service has `publish: false` and no private proxy URL, so its
private Tailscale view cannot preview this loopback-only service. Adding a trusted parent does
not enable a proxy or change API Host/origin admission. Private access needs a separate,
reviewed proxy/authentication integration.
The [private dashboard framing note](docs/framing.md) explains the retained lightweight policy.

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
pnpm --filter @lib/db-map ingest:inventory --file data/poi/rv_campgrounds_data/thedyrt/rv_campgrounds.csv --json
pnpm --filter @lib/db-map ingest:test-inventory
pnpm --filter @lib/db-map ingest:test-inventory:integration
pnpm --filter @app/ingestion check-types
pnpm --filter @app/ingestion test
```

The integration test writes two isolated non-POI fixture records, scans the checkout, and removes
its own fixtures. It calls no providers. Provider metrics in the UI cover attributed normalization
requests; legacy calls and matching/fusion costs are not included. There is no scheduler or alert
delivery while the app is closed. See the [shared runbook](../../poi-ingestion.md).

## Shared operations view

`GET /api/overview` powers the active-work, intervention, performance and quality panels and the
agent `ingest:overview` CLI. `inventory=1` returns both projections in one snapshot; bounded
file pagination and run/file/detail filters are documented in the shared ingestion runbook.
The dashboard renders the assessment and preserves draft edits while refreshing. Launch and
record-repair commands remain in the managed CLI. Database outages display unknown evidence
and suppress launch recommendations. Quality reviews remain explicit audited sample evidence.
