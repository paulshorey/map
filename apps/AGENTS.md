# apps/

Application packages in the monorepo. Each subdirectory is a deployable app with its own `package.json`.

## Current apps

| App | Path | Description |
| --- | --- | --- |
| POI Map | `map/` | Next.js + Capacitor map app — see `map/AGENTS.md` |

## Conventions

- Apps depend on shared libraries under `lib/` via workspace protocol (`@lib/db-map`, `@lib/config`).
- Turbo orchestrates `dev`, `build`, and `lint` from the repo root (`turbo.json`).
- New apps should follow the same pattern: `apps/<name>/`, extend `@lib/config/typescript/nextjs.json` if using Next.js.
