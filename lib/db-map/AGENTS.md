# @lib/db-map

Database-first package: migrations, SQL queries, generated types, and app API contracts. Consumed by `apps/map` API routes and import scripts.

## Directory map

| Path | Purpose |
| --- | --- |
| `migrations/` | Timestamped SQL migrations (`YYYYMMDDHHMM__description.sql`). Currently a single `__baseline.sql` (greenfield). |
| `schema/current.sql` | Auto-generated schema snapshot after migrate |
| `sql/` | Typed query functions (`pois.ts`, `users.ts`) — use these, not raw SQL in the app |
| `contracts/map-app.ts` | Hand-maintained TypeScript types for API payloads |
| `generated/typescript/` | Auto-generated row types from schema |
| `generated/contracts/` | JSON schemas derived from contracts |
| `scripts/` | Migrate, snapshot, typegen, import, seed tooling |
| `scripts/ingest/` | POI ingestion pipeline (extract → normalize → geocode → embed → match). See the plans in `.cursor/plans/poi-ingestion-*.md`. |
| `lib/db/postgres.ts` | `getDb()` — pg Pool from `DB_MAP_URL` |

Public exports: `index.ts` re-exports db, sql, and types.

## Schema (current) — two-layer POI architecture

Raw source data lands in `research_*` tables; the de-duplicated, user-facing places live in
`canonical_*` tables. The ingestion pipeline conflates the former into the latter. Portable
schema — **no PostGIS/pgvector**: plain `lng`/`lat` doubles, `real[]` embeddings, `pg_trgm` for
name similarity, `tstzrange` for event dates.

**Published (user-facing):**
- **`canonical_pois`** — merged place: name, description, lng/lat, `attributes` (jsonb), `field_provenance`, `popularity`, `status`, event dates (`starts_at`/`ends_at`/`date_precision`/`event_range`), and `primary_category_id` (denormalized shortcut). **No `UNIQUE (lng,lat)`** — dedup is done by the matcher, not coordinate equality.
- **`canonical_categories`** — code-owned taxonomy (slug, display_name, `parent_id`, `is_temporal`). Seeded from `scripts/ingest/taxonomy.ts`.
- **`canonical_poi_categories`** — M:N place↔category (source of truth) with `is_primary`.
- **`canonical_poi_occurrences`** — recurring event editions.

**Research (raw/staging):**
- **`research_sources`** — source registry (slug, license, attribution, trust).
- **`research_pois`** — one row per (source, record). Derived state is column NULL-ness (`name_normalized`, `lat`, `content_embedding`, `canonical_poi_id`); `content_hash` versions input; `category_slugs text[]` + `is_poi` are set by normalize. `UNIQUE (source_id, source_record_id)` is the idempotency anchor.
- **`research_category_aliases`**, **`research_match_decisions`**, **`research_match_overrides`**, **`research_geocode_cache`** — alias map, match audit, manual overrides, geocode dedupe/miss cache.

**Auth:**
- **`users`** — text id, display_name, tier (`free` \| `premium`), is_guest
- **`user_preferences`** — per-user basemap_id, last viewport, FK to users

## Ingestion pipeline

Per-source, resumable, idempotent stages (one **category × source** at a time):

```bash
pnpm --filter @lib/db-map ingest:extract <source> <file> [--limit N] [--dry-run]
pnpm --filter @lib/db-map ingest:normalize [--source <slug>] [--report-unmapped] [--report-coverage]
pnpm --filter @lib/db-map ingest:geocode [--source <slug>] [--geocode-limit N]
pnpm --filter @lib/db-map ingest:taxonomy:seed
```

## Workflow: schema changes

1. Create migration: `pnpm --filter @lib/db-map db:migration:new -- description`
2. Edit the new file in `migrations/`
3. Run full sync from repo root or package:

```bash
cd lib/db-map && pnpm db:sync
```

This runs migrate → schema snapshot → typegen → contract JSON generation. **Commit all generated artifacts** with the migration.

4. If API shapes change, update `contracts/map-app.ts` and run `pnpm app:contract:check` (also runs in app build).

## Importing POIs

Two paths:
- **Ingestion pipeline** (bulk, de-duplicated, with provenance) — the primary path for real data; see the ingestion commands above and `.cursor/plans/poi-ingestion-*.md`.
- **Direct curated insert** (`insertPois()` in `sql/pois.ts`) — used by `db:seed` and `IMPORTING.md`'s KML/JSON importers for dev fixtures and small curated sets. Writes straight to `canonical_pois` + `canonical_poi_categories` (+ `primary_category_id`); it does **not** upsert on lng/lat (no such constraint) and does not compute provenance/popularity. Per the M9 plan these importers will move to staging under a `manual` source.

POI source files and research notes live in repo `docs/poi/`.

## Environment

| Variable | Required |
| --- | --- |
| `DB_MAP_URL` | PostgreSQL connection string |

No `.env` files in repo — vars must be in the shell (see root `AGENTS.md`).

## Quirks

- `listPoisGeoJson` builds GeoJSON in SQL (`jsonb_build_object`) — not PostGIS.
- World-view requests (`isWorldView`) skip bbox filter and cap by limit only.
- App build fails if generated contracts drift: `apps/map` runs `contracts:check` before `next build`.
- `queries/` folder is reserved/placeholder — active queries are in `sql/*.ts`.
- **`pg_dump` version**: `db:sync` / `db:verify` / `db:schema:snapshot` require a `pg_dump` whose major version matches the server (currently 18). If the default on `PATH` is older (e.g. 16), prepend the right bin dir: `export PATH="/usr/lib/postgresql/18/bin:$PATH"`.
- **Greenfield migrations**: the baseline is edited in place until launch, so an existing DB must be wiped (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`) before re-applying. After launch, migrations become append-only.
