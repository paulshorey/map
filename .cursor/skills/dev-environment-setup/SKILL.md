---
name: dev-environment-setup
description: Set up or repair the development environment — PostgreSQL, migrations, seed data, pg_dump, dev server. Use when the database is missing, services fail to start, pg_dump is unavailable, or dependencies need reinstalling.
disable-model-invocation: true
---

# Dev Environment Setup

Prefer the portable bootstrap:

```bash
bash scripts/agent-env.sh setup
bash scripts/agent-env.sh check
bash scripts/agent-env.sh start    # map on :5000
```

Do not create repository `.env` files. Inject `DB_MAP_URL` in the shell or let
`scripts/agent-env.sh` persist host-provided values to `~/.config/poi-map/agent.env`.

## Prerequisites

- Node.js >=20 (22 preferred) and pnpm 10.28.1
- `psql` / `pg_dump` matching the PostgreSQL server major (shared DB is 18)
- `pg_trgm` on the target database

## Shared remote database (default)

`DB_MAP_URL` is already in the shell on Cursor Cloud. Use it without printing
credentials. The bootstrap applies pending migrations and seeds taxonomy only.

## Isolated local database

```bash
bash scripts/agent-env.sh setup --local-db --seed
```

This installs PostgreSQL, creates `poi_map`, enables `pg_trgm`, and seeds sample
POIs. Do not seed the shared remote database.

## Manual pieces (already handled by the script)

```bash
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm --filter @lib/db-map ingest:taxonomy:seed
pnpm --filter ./apps/map build
pnpm dev                    # http://127.0.0.1:5000
```

Schema snapshots:

```bash
pnpm --filter @lib/db-map db:schema:snapshot
```

`snapshot-schema.sh` uses `scripts/sql-check-postgres-client-version.sh` so
`pg_dump` matches the server.

## Reinstalling PGDG client tools

If `postgresql-client-18` is missing on Ubuntu:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg
echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" | sudo tee /etc/apt/sources.list.d/pgdg.list
sudo apt-get update -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/pgdg.list -o Dir::Etc::sourceparts=-
sudo apt-get install -y postgresql-client-18
```
