# This is a map app

It shows a world map with many points of interest. User clicks a point to see more information about it.

Front-end - NextJS React, renders the map and UI
Back-end - NextJS app router API, connects to the database and fetches points of interest

## Codebase

This is a mono-repo. Apps go into ./apps and libraries go into ./lib folder.

- apps/map - the main app, uses Capacitor framework to build web, ios, and android apps
- lib/db-map - database migrations, contracts, and types

## Cursor Cloud specific instructions

### Services

| Service | How to run |
|---------|-----------|
| PostgreSQL 16 | `sudo pg_ctlcluster 16 main start` (pre-installed, auto-starts if already running) |
| Next.js dev server | `export DB_MAP_URL=<value from .env.example> && pnpm dev` (port 3000) |

### Environment setup notes

- **DB_MAP_URL** must be available to the Next.js process. Place a `.env` file in `apps/map/` with the `DB_MAP_URL` connection string (see `.env.example` for the default value). Next.js loads `.env` from its own CWD, which is `apps/map/` when launched via turbo — a root-level `.env` alone is **not** sufficient.
- The `pnpm-workspace.yaml` includes `onlyBuiltDependencies` for `esbuild` and `sharp` to avoid the interactive `pnpm approve-builds` prompt.
- The app uses a **guest-first** auth model — no login is required. `GET /api/me` returns a built-in guest user.
- **pg_dump v18** is available at `/usr/lib/postgresql/18/bin/pg_dump` (installed from PGDG apt repo). Used by `lib/db-map/scripts/snapshot-schema.sh` for database schema snapshots.

### Common commands

| Task | Command |
|------|---------|
| Install deps | `pnpm install` |
| Run migrations | `pnpm db:migrate` (requires DB_MAP_URL in env or apps/map/.env) |
| Seed data | `pnpm db:seed` (requires DB_MAP_URL) |
| Dev server | `pnpm dev` (turborepo, runs all workspace dev tasks) |
| Lint | `pnpm lint` |
| Type check (db-map) | `pnpm run verify:db-contracts` |
| Type check (map) | `pnpm --filter map check-types` |
| Full verify | `pnpm verify` |

### Known pre-existing issues

- `pnpm lint` fails due to `@typescript-eslint/triple-slash-reference` on auto-generated `next-env.d.ts` — this is a configuration issue, not a code issue.
- `tsc --noEmit` in `apps/map` reports strictness errors (possibly undefined values). These don't prevent the app from running.
