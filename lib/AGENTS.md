# lib/

Shared libraries consumed by apps in this monorepo. Not published externally — workspace packages only.

## Packages

| Package | Path | Purpose |
| --- | --- | --- |
| `@lib/db-map` | `db-map/` | PostgreSQL migrations, SQL queries, generated types, API contracts — see `db-map/AGENTS.md` |
| `@lib/config` | `config/` | Shared TypeScript config presets — see `config/AGENTS.md` |

## Usage in apps

Apps reference libraries in `package.json`:

```json
"@lib/db-map": "workspace:*",
"@lib/config": "workspace:*"
```

Import from package root or subpaths (see each package's `exports` in `package.json`).

## Database commands (from repo root)

All delegate to `@lib/db-map`:

```bash
pnpm db:migrate
pnpm db:verify
pnpm db:seed
pnpm db:import:kml -- path/to/file.kml
pnpm db:import:json -- path/to/file.json
```

After schema changes, run `cd lib/db-map && pnpm db:sync` and commit generated files.
