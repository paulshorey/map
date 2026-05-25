# POI Map

Interactive map app — users browse points of interest and click for details.

- `apps/map` — Next.js 15 + Capacitor (web, iOS, Android)
- `lib/db-map` — PostgreSQL migrations, SQL queries, contracts
- `lib/config` — shared tsconfig presets

Dev server: `pnpm dev` (port 3000). Guest auth, no login required.

**Gotcha:** `DB_MAP_URL` must be in `apps/map/.env`, not the repo root — Next.js loads `.env` from its own CWD when run via turbo.
