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

- `README.md` — concise human setup and ingestion commands
- `docs/poi-ingestion.md` — deep-dive POI ingestion and conflation guide
- `docs/` — POI source files, import staging, research notes — see `docs/AGENTS.md`
- `docs/poi/{category}/` — source files and notes per POI category

### Folder guides (AGENTS.md)

| Path                    | Topic                                  |
| ----------------------- | -------------------------------------- |
| `apps/map/`             | Next.js app, Capacitor, Railway deploy |
| `apps/map/src/`         | Source layout and key flows            |
| `apps/map/src/app/`     | Pages and API routes                   |
| `apps/map/src/auth/`    | User session and entitlements          |
| `apps/map/src/basemap/` | Tile providers                         |
| `apps/map/src/map/`     | MapLibre map and POI UI                |
| `apps/map/src/lib/`     | Shared helpers                         |
| `lib/db-map/`           | Migrations, SQL, contracts             |
| `lib/`                  | Monorepo libraries overview            |

## Environment variables

This project does not use .env files. Instead, all environment variables are preconfigured in the shell environment. The .env.example only serves to show the developer which env vars are used by the project, to make sure they are available in the shell.

## Database

Database connection string in `DB_MAP_URL` env var. Feel free to read and write to the remote database. We're starting from scratch. Everything is backed up, so don't be afraid to run migrations and other destructive actions.

After making a change requiring database migration, run the sync pipeline and commit the generated files in the same PR:

```bash
cd lib/db-map && pnpm db:sync
```

This migrates the database, snapshots the schema, and regenerates TypeScript types and contracts. The updated files in `schema/` and `generated/` must be committed alongside the migration.

## POI ingestion workflow for agents

Use the staged pipeline for real source data:

```bash
pnpm --filter @lib/db-map ingest:taxonomy:seed
pnpm --filter @lib/db-map ingest:extract <source-slug> <file> --category <category-slug>
pnpm --filter @lib/db-map ingest:normalize [--source <source-slug>]
pnpm --filter @lib/db-map ingest:geocode [--source <source-slug>] [--geocode-limit 4500]
pnpm --filter @lib/db-map ingest:embed [--source <source-slug>]
pnpm --filter @lib/db-map ingest:match --consolidate
pnpm --filter @lib/db-map ingest:report [--source <source-slug>]
```

Notes:

- `ingest:extract` resolves relative file paths against `lib/db-map/`; pass absolute paths.
- Sources registered in `sources.ts` without a custom extractor use the generic extractor
  for files following `docs/poi-research/capture-spec.md` — new conformant sources need
  only a metadata entry, no extractor code.
- Re-importing a file is idempotent: unchanged records keep their `canonical_poi_id`; only
  new/changed records re-flow. You never need to re-match or re-consolidate "everything".
- Consolidation memoizes anchor-vs-anchor LLM verdicts in
  `research_consolidation_decisions`; reruns of `--consolidate` are cheap.
- `ingest:report` is read-only; run it before and after imports to verify state.

`ingest:match` is resumable. Progress is `research_pois.canonical_poi_id`; normal reruns skip linked rows and continue pending rows. First `Ctrl-C` stops gracefully after the current unit and prints a resume command.

Common match operations:

```bash
pnpm --filter @lib/db-map ingest:match --limit 500
pnpm --filter @lib/db-map ingest:match --consolidate-only --dry-run
pnpm --filter @lib/db-map ingest:match --consolidate-only
```

Do not use `--recluster` unless the user explicitly asks to start over or approves destructive reclustering. `--recluster` deletes match decisions, unlinks all research rows, deletes canonicals, and rebuilds from raw research rows.

Use `--dry-run`, `--limit`, and `--no-llm` for investigation when appropriate, but avoid leaving a production import half-described: report linked/pending counts and the exact resume command.
