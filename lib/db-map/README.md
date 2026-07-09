# @lib/db-map

Database-first package for the POI map application. It owns migrations, schema snapshots,
generated row types, app-facing contracts, SQL query helpers, and the POI ingestion pipeline.

## Directory Map

| Path                    | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `migrations/`           | Timestamped SQL migrations.                                             |
| `schema/current.sql`    | Generated schema snapshot after `db:sync`.                              |
| `generated/typescript/` | Generated database row types.                                           |
| `generated/contracts/`  | Generated JSON schemas for app contracts.                               |
| `contracts/map-app.ts`  | Hand-maintained app API payload contracts.                              |
| `sql/`                  | Shared query helpers used by the app.                                   |
| `scripts/ingest/`       | Extract, normalize, geocode, embed, match, and maintenance scripts.     |
| `data/`                 | Static ingest support data, such as GeoNames centroids.                 |
| `lib/db/postgres.ts`    | `getDb()` Postgres pool backed by `DB_MAP_URL`.                         |

## Environment

This repo does not use `.env` files. Environment variables must already be available in the
shell.

| Variable     | Required | Description                    |
| ------------ | -------- | ------------------------------ |
| `DB_MAP_URL` | yes      | PostgreSQL connection URL.     |

Provider keys used by the ingest stages are configured in `scripts/ingest/config.ts`.

## Schema Model

POI data has two layers:

- `research_*` tables store raw or staged source records. These rows are internal and kept
  for provenance, re-ingestion, matching, and debugging.
- `canonical_*` tables store the de-duplicated POIs served to the map app.

Important tables:

- `research_sources`: source registry and trust metadata.
- `research_pois`: one row per source record. Derived pipeline progress is represented by
  nullable columns such as `name_normalized`, `lat`, `content_embedding`, and
  `canonical_poi_id`.
- `research_geocode_cache`: forward-geocode cache and remembered misses.
- `research_match_decisions`: audit trail for match decisions.
- `research_match_overrides`: manual force-same / force-different corrections.
- `canonical_pois`: merged, user-facing POIs.
- `canonical_categories`: code-owned taxonomy.
- `canonical_poi_categories`: many-to-many POI/category links.
- `canonical_poi_occurrences`: event editions.

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

## POI Ingestion Pipeline

The normal pipeline is:

```bash
pnpm --filter @lib/db-map ingest:taxonomy:seed
pnpm --filter @lib/db-map ingest:extract <source> <file> --category <slug>
pnpm --filter @lib/db-map ingest:normalize [--source <slug>] [--no-llm]
pnpm --filter @lib/db-map ingest:geocode [--source <slug>] [--geocode-limit N]
pnpm --filter @lib/db-map ingest:embed [--source <slug>] [--batch-size N]
pnpm --filter @lib/db-map ingest:match [options]
```

Supporting maintenance commands:

```bash
pnpm --filter @lib/db-map ingest:seed:centroids
pnpm --filter @lib/db-map ingest:backfill:wikidata-coords
pnpm --filter @lib/db-map ingest:reflow
pnpm --filter @lib/db-map ingest:override
pnpm --filter @lib/db-map ingest:match:golden --no-llm
```

Each stage is intended to be resumable. Re-running a stage should pick up rows whose derived
output is still missing or was reset by a source/content change.

## `ingest:match`

`ingest:match` links normalized and geocoded `research_pois` rows into `canonical_pois`,
using stored embeddings when present. It is the conflation step.

The script selects matchable rows where:

- `canonical_poi_id IS NULL`
- `is_poi` is true
- `lat` and `lng` are present
- `name_normalized` is present
- `category_slugs` is present

Each processed row is committed in its own transaction. The durable checkpoint is
`research_pois.canonical_poi_id`, so a normal rerun skips already linked rows and continues
with pending rows.

### Safe Resume

Use this for the normal long-running path:

```bash
pnpm --filter @lib/db-map ingest:match --consolidate
```

If the command is interrupted, run the same command again. Completed rows stay linked; the
interrupted in-flight row rolls back and remains pending.

To work in smaller chunks:

```bash
pnpm --filter @lib/db-map ingest:match --limit 500
pnpm --filter @lib/db-map ingest:match --limit 500
pnpm --filter @lib/db-map ingest:match --consolidate --limit 0
```

`--consolidate --limit 0` skips row matching and runs only the canonical consolidation
sweep. It is the current consolidation-only command.

### Start Over From Scratch

`--recluster` is destructive. It deletes match decisions, unlinks every research row from
its canonical, deletes canonicals, and rebuilds clusters from the raw research rows.

Only use it when you intentionally want a full rebuild:

```bash
pnpm --filter @lib/db-map ingest:match --recluster --consolidate
```

Do not use `--recluster` to resume a stopped run.

### Useful Match Commands

```bash
# Preview the next few row decisions without writing.
pnpm --filter @lib/db-map ingest:match --dry-run --limit 20 --no-llm

# Resume matching one source only.
pnpm --filter @lib/db-map ingest:match --source wikidata --limit 1000

# Run deterministic matching without match-adjudication LLM calls.
pnpm --filter @lib/db-map ingest:match --no-llm

# Preview canonical-vs-canonical consolidation plans.
pnpm --filter @lib/db-map ingest:match --consolidate --limit 0 --dry-run

# Hide visible canonicals that no research rows reference.
pnpm --filter @lib/db-map ingest:match --gc-orphans
```

### Match Options

| Option | Effect |
| ------ | ------ |
| `--source <slug>` | Process pending rows from one source. |
| `--limit N` | Stop after processing N research rows. `0` is useful with `--consolidate`. |
| `--dry-run` | Print decisions without writing row links or canonicals. |
| `--no-llm` | Skip match-adjudication LLM calls and description fusion. Ambiguous matches become new POIs. |
| `--consolidate` | After row matching, merge canonical POIs that should collapse together. |
| `--recluster` | Destructively reset all clusters and rebuild from scratch. Cannot combine with `--source`, `--limit`, or `--dry-run`. |
| `--gc-orphans` | Hide non-hidden canonicals that have no linked research rows. |
| `--auto-threshold N` | Override the high score threshold for automatic merges. |
| `--low-threshold N` | Override the low score threshold below which rows become new POIs. |

### Provider Calls and Performance

`ingest:match` does not geocode rows and does not create embeddings. Geocoding and
embedding happen in earlier stages.

During matching, provider calls can still happen in two places:

- Gray-zone match adjudication, via the LLM.
- Canonical description fusion inside `rebuildCanonicalPoi`, when multiple source
  descriptions disagree and `--no-llm` is not set.

Most match work is deterministic: strong IDs, proximity rules, name similarity, stored
embedding similarity, date compatibility, and category/location blocking. The current
implementation is intentionally row-at-a-time and safe to resume, but it can be slow against
a remote database because each linked row writes an audit decision and rebuilds the touched
canonical.

See `.cursor/plans/poi-match-resume-batch-performance.md` for the plan to add startup
progress banners, graceful stop summaries, `--consolidate-only`, deterministic batch passes,
and deferred canonical rebuilds.

## Source Data

Source files and research notes live under `docs/poi/`. Folder-specific instructions live in
`docs/AGENTS.md`.

## Notes

- The app should use query helpers in `sql/`, not ad hoc SQL.
- App builds fail if generated contracts drift.
- `pg_dump` used by schema snapshotting must match the server major version.
- Before launch, baseline-style migrations may still be rewritten for a greenfield DB. After
  launch, migrations should be append-only.
