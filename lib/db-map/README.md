# @lib/db-map

Database-first package for the POI map application. It owns migrations, schema snapshots,
generated row types, app-facing contracts, SQL query helpers, and the POI ingestion pipeline.

## Directory Map

| Path                    | Purpose                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `migrations/`           | Timestamped SQL migrations.                                         |
| `schema/current.sql`    | Generated schema snapshot after `db:sync`.                          |
| `generated/typescript/` | Generated database row types.                                       |
| `generated/contracts/`  | Generated JSON schemas for app contracts.                           |
| `contracts/map-app.ts`  | Hand-maintained app API payload contracts.                          |
| `sql/`                  | Shared query helpers used by the app.                               |
| `scripts/ingest/`       | Extract, normalize, geocode, embed, match, and maintenance scripts. |
| `data/`                 | Static ingest support data, such as GeoNames centroids.             |
| `lib/db/postgres.ts`    | `getDb()` Postgres pool backed by `DB_MAP_URL`.                     |

## Environment

This repo does not use `.env` files. Environment variables must already be available in the
shell.

| Variable     | Required | Description                |
| ------------ | -------- | -------------------------- |
| `DB_MAP_URL` | yes      | PostgreSQL connection URL. |

Provider keys used by the ingest stages are configured in `scripts/ingest/config.ts`.

## Schema Model

POI data has two layers:

- `research_*` tables store raw or staged source records. These rows are internal and kept
  for provenance, re-ingestion, matching, and debugging.
- `canonical_*` tables store the de-duplicated POIs served to the map app.

See the [ingestion runbook's data model](../../data/poi-ingestion.md#durable-state) for tables,
artifact history, memberships, and canonical builds.

The database intentionally avoids PostGIS and pgvector. Coordinates are plain `lng`/`lat`
doubles, embeddings are `real[]`, and fuzzy name blocking uses `pg_trgm`.

## Common Commands

Run from the repo root unless noted.

```bash
pnpm --filter @lib/db-map db:migrate
pnpm --filter @lib/db-map db:schema:snapshot
pnpm --filter @lib/db-map db:types:generate
pnpm --filter @lib/db-map app:contract:generate
```

For schema changes, run the full sync from the package directory:

```bash
cd lib/db-map && pnpm db:sync
```

`db:sync` runs migrations, snapshots the schema, regenerates TypeScript row types, and
regenerates contract JSON. Commit the migration plus the updated generated files.

Create a new migration with:

```bash
pnpm --filter @lib/db-map db:migration:new -- short_description
```

## POI Ingestion

Use the [root README](../../README.md#poi-ingestion) for manual full runs and the
[ingestion runbook](../../data/poi-ingestion.md) for the command reference, bounded stage
recipes, category assessment, record tracing, cleanup, and troubleshooting.

Agent development and execution responsibilities are in [AGENTS.md](AGENTS.md) and the
[root agent guide](../../AGENTS.md). Long-running stages remain within the agent's
operational scope; humans usually launch full workloads after bounded validation. Use the shared
[process-control workflow](../../data/poi-ingestion.md#process-control-and-maintenance) to stop
workers and close admission before runtime/schema edits.

## Source Data

Source files and research notes live under `data/poi/`. Folder-specific instructions live in
`AGENTS.md`.

## Notes

- The app should use query helpers in `sql/`, not ad hoc SQL.
- App builds fail if generated contracts drift.
- `pg_dump` used by schema snapshotting must match the server major version.
  `scripts/sql-check-postgres-client-version.sh` selects the matching client
  binaries. Cloud agent hosts should run `bash scripts/agent-env.sh setup`.
- Before launch, baseline-style migrations may still be rewritten for a greenfield DB. After
  launch, migrations should be append-only.

## Location assessment regression and preview

Use the [ingestion runbook](../../data/poi-ingestion.md#location-assessment)
for the advisory policy, publication behavior, cache identity and rollout rules. These checks
use the committed review evidence and do not call providers:

```bash
pnpm --filter @lib/db-map ingest:test-location-assessment
pnpm --filter @lib/db-map check-types
```

Database integration requires an explicitly named, disposable local PostgreSQL database.
It refuses other database names/hosts, rolls its fixtures back, and fails any network
provider request. Use a database with this checkout's migrations:

```bash
DB_MAP_URL=postgresql://127.0.0.1:55440/map_location_assessment_test pnpm --filter @lib/db-map db:migrate
MAP_LOCATION_ASSESSMENT_TEST_URL=postgresql://127.0.0.1:55440/map_location_assessment_test pnpm --filter @lib/db-map ingest:test-location-assessment:integration
```

Preview the current policy for 1–100 explicit research POI IDs. The command uses a
read-only repeatable snapshot, returns JSON with missing IDs/status/reasons, and does
not activate assessments, alter publication or make provider calls. It also works
before the new assessment migration, using the existing source artifacts:

```bash
pnpm --silent --filter @lib/db-map ingest:location-assess --records <UUID,UUID,...>
```
