# POI Map

Interactive map app — users browse points of interest and click for details.

- `apps/map` — Next.js 15 + Capacitor (web, iOS, Android)
- `lib/db-map` — PostgreSQL migrations, SQL queries, contracts
- `lib/config` — shared tsconfig presets

Dev server: `pnpm dev` (port 3000). Guest auth, no login required.

## Codebase

This is a mono-repo. Apps go into ./apps and libraries go into ./lib folder.

- apps/map/ - the main app, uses Capacitor framework to build web, ios, and android apps
- lib/db-map/ - database migrations, contracts, and types

## Documentation

- `.cursor/plans/` — implementation plans (features, fixes, research)
- `docs/` — POI source files, import staging, research notes — see `docs/AGENTS.md`
- `docs/pois/{category}/` — KML sources and notes per POI category

### Folder guides (AGENTS.md)

| Path | Topic |
| --- | --- |
| `apps/map/` | Next.js app, Capacitor, Railway deploy |
| `apps/map/src/` | Source layout and key flows |
| `apps/map/src/app/` | Pages and API routes |
| `apps/map/src/auth/` | User session and entitlements |
| `apps/map/src/basemap/` | Tile providers |
| `apps/map/src/map/` | MapLibre map and POI UI |
| `apps/map/src/lib/` | Shared helpers |
| `lib/db-map/` | Migrations, SQL, contracts |
| `lib/` | Monorepo libraries overview |

## Environment variables

This project does not use .env files. Instead, all environment variables are preconfigured in the shell environment. The .env.example only serves to show the developer which env vars are used by the project, to make sure they are available in the shell.

Database connection string in `DB_MAP_URL` env var.

## Database

After making a change requiring database migration, run the sync pipeline and commit the generated files in the same PR:

```bash
cd lib/db-map && pnpm db:sync
```

This migrates the database, snapshots the schema, and regenerates TypeScript types and contracts. The updated files in `schema/` and `generated/` must be committed alongside the migration.
