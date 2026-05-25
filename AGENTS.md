# This is a map app

It shows a world map with many points of interest. User clicks a point to see more information about it.

Front-end - NextJS React, renders the map and UI
Back-end - NextJS app router API, connects to the database and fetches points of interest

## Codebase

This is a mono-repo. Apps go into ./apps and libraries go into ./lib folder.

- apps/map - the main app, uses Capacitor framework to build web, ios, and android apps
- lib/db-map - database migrations, contracts, and types

## Database

PostgreSQL 18. Connection string is in `DB_MAP_URL` environment variable.

### Commands

From the repo root:

- `pnpm db:migrate` — apply pending migrations
- `pnpm db:seed` — seed sample POIs (destructive: replaces all POIs)
- `pnpm db:import:kml /absolute/path/to/file.kml --category "Name" --dry-run` — import from KML
- `pnpm db:import:json /absolute/path/to/file.json --category "Name" --dry-run` — import from JSON

The full sync pipeline (after writing a new migration):

```bash
pnpm db:migrate
cd lib/db-map && bash scripts/snapshot-schema.sh
cd lib/db-map && node scripts/generate-types.mjs
cd lib/db-map && node scripts/generate-app-contract.mjs --write
```

Or from `lib/db-map`: `pnpm db:sync`

### PostgreSQL client tools (pg_dump, psql)

The schema snapshot script (`lib/db-map/scripts/snapshot-schema.sh`) requires `pg_dump` matching the server's major version. The server runs **PostgreSQL 18**.

If `pg_dump` is missing or the wrong version, install from the PGDG apt repository:

```bash
sudo sh -c 'echo "deb http://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list'
wget --quiet -O - https://www.postgresql.org/media/keys/ACCC4CF8.asc | sudo apt-key add -
sudo apt-get update
sudo apt-get install -y postgresql-client-18
```

After installing, the version-checking script at `scripts/check-postgres-client-version.sh` will find the correct binary at `/usr/lib/postgresql/18/bin/pg_dump`.
