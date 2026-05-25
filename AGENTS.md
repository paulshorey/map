# This is a map app

It shows a world map with many points of interest. User clicks a point to see more information about it.

Front-end - NextJS React, renders the map and UI
Back-end - NextJS app router API, connects to the database and fetches points of interest

## Codebase

This is a mono-repo. Apps go into ./apps and libraries go into ./lib folder.

- apps/map - the main app, uses Capacitor framework to build web, ios, and android apps
- lib/db-map - database migrations, contracts, and types

## Database

PostgreSQL 18. Connection via `DB_MAP_URL` env var.

### After making schema changes

When a code change requires a new migration, run the full sync pipeline and commit the generated files in the same PR:

```bash
pnpm db:migrate
cd lib/db-map && bash scripts/snapshot-schema.sh
cd lib/db-map && node scripts/generate-types.mjs
cd lib/db-map && node scripts/generate-app-contract.mjs --write
```

This updates `schema/current.sql`, `generated/typescript/db-types.ts`, and `generated/contracts/`. These generated files must be committed alongside the migration.
