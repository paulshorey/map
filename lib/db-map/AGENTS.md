# @lib/db-map

Database-first package: migrations, SQL queries, generated types, and app API contracts. Consumed by `apps/map` API routes and import scripts.

## Directory map

| Path | Purpose |
| --- | --- |
| `migrations/` | Timestamped SQL migrations (`YYYYMMDDHHMM__description.sql`) |
| `schema/current.sql` | Auto-generated schema snapshot after migrate |
| `sql/` | Typed query functions (`pois.ts`, `users.ts`) — use these, not raw SQL in the app |
| `contracts/map-app.ts` | Hand-maintained TypeScript types for API payloads |
| `generated/typescript/` | Auto-generated row types from schema |
| `generated/contracts/` | JSON schemas derived from contracts |
| `scripts/` | Migrate, snapshot, typegen, import, seed tooling |
| `lib/db/postgres.ts` | `getDb()` — pg Pool from `DB_MAP_URL` |

Public exports: `index.ts` re-exports db, sql, and types.

## Schema (current)

- **`pois`** — UUID id, name, category, lng/lat, optional description/address/website/hours/photo_url. Unique on `(lng, lat)`.
- **`users`** — text id, display_name, tier (`free` \| `premium`), is_guest
- **`user_preferences`** — per-user basemap_id, last viewport, FK to users

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

See `IMPORTING.md` for KML/JSON import commands. Inserts go through `insertPois()` in `sql/pois.ts` (batch with per-row fallback, upsert on lng/lat conflict).

POI source files and research notes live in repo `docs/pois/{category}/`.

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
