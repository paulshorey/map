---
name: dev-environment-setup
description: Set up or repair the development environment — PostgreSQL, migrations, seed data, pg_dump, dev server. Use when the database is missing, services fail to start, pg_dump is unavailable, or dependencies need reinstalling.
disable-model-invocation: true
---

# Dev Environment Setup

## Prerequisites

- Node.js >=20 and pnpm 10+ (pre-installed)
- PostgreSQL 16 server (pre-installed)
- postgresql-client-18 from PGDG apt repo (pre-installed, provides `/usr/lib/postgresql/18/bin/pg_dump`)

## Start PostgreSQL

```bash
sudo pg_ctlcluster 16 main start
```

## Install dependencies

```bash
pnpm install
```

`pnpm-workspace.yaml` has `onlyBuiltDependencies` for `esbuild` and `sharp` — no interactive approval needed.

## Database setup

```bash
sudo -u postgres createdb poi_map
# Set DB_MAP_URL to the connection string from .env.example
echo "DB_MAP_URL=<connection-string>" > apps/map/.env
pnpm db:migrate
pnpm db:seed          # 54 sample POIs
```

See `.env.example` for the default `DB_MAP_URL` value. It **must** go in `apps/map/.env` — turbo runs Next.js with CWD `apps/map/`, so a root `.env` won't be loaded.

## Dev server

```bash
pnpm dev              # http://localhost:3000
```

## Common commands

| Task | Command |
|------|---------|
| Migrations | `pnpm db:migrate` |
| Seed data | `pnpm db:seed` |
| Lint | `pnpm lint` |
| Type check | `pnpm verify` |
| Schema snapshot | `DB_MAP_URL=... pnpm --filter @lib/db-map db:schema:snapshot` |

## Known lint/type issues

- `pnpm lint` flags `next-env.d.ts` (auto-generated) — pre-existing, not a code bug.
- `tsc --noEmit` in `apps/map` reports strictness warnings — doesn't block runtime.

## Reinstalling PGDG client tools

If `postgresql-client-18` is missing:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg
echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/pgdg.list -o Dir::Etc::sourceparts=-
sudo apt-get install -y postgresql-client-18
```
