# @lib/db-map

Database-first package for the POI map application.

- **Migrations** — canonical schema in `migrations/`
- **Contracts** — app-facing TypeScript types in `contracts/map-app.ts`
- **Generated artifacts** — row types and JSON schemas in `generated/`
- **SQL layer** — shared queries in `sql/`

## Environment

| Variable     | Description                |
| ------------ | -------------------------- |
| `DB_MAP_URL` | PostgreSQL connection URL  |

## Commands

Run from the repo root:

```bash
pnpm db:migrate          # Apply pending migrations
pnpm db:migrate:baseline # Mark baseline applied (existing DBs)
pnpm db:verify           # Migrate, regenerate artifacts, assert schema
pnpm db:seed             # Seed sample POI data
```

Or from this package:

```bash
pnpm --filter @lib/db-map db:migration:new -- add_column_name
```

## Workflow

1. Add a migration in `migrations/YYYYMMDDHHMM__description.sql`
2. Update structural assertions in `scripts/verify-contract.mjs` if needed
3. Run `pnpm db:verify` and commit generated files
