# apps/map

Main POI Map application — Next.js 15 web app with Capacitor shells for iOS and Android. Deployed to Railway for the hosted API and web UI.

## What lives here

| Path                  | Purpose                                                      |
| --------------------- | ------------------------------------------------------------ |
| `src/`                | Application source — see `src/AGENTS.md`                     |
| `public/`             | Static assets (favicon)                                      |
| `scripts/`            | Capacitor build helper                                       |
| `ios/`, `android/`    | Native Capacitor projects (generated/synced, edit sparingly) |
| `next.config.ts`      | Next.js config; static export for mobile builds              |
| `capacitor.config.ts` | App id, webDir (`out`), native plugin settings               |
| `.railway/railway.ts` | Root-level Railway infrastructure config and healthcheck     |

## Commands

Run from repo root or this directory:

```bash
pnpm dev              # Next dev server (port 5000)
pnpm build            # Production web build (runs db contract check first)
pnpm start            # Serve production build
pnpm verify           # Typecheck + build
pnpm cap:sync         # Static mobile build + cap sync
pnpm cap:ios          # Open Xcode
pnpm cap:android      # Open Android Studio
```

Root workspace shortcuts: `pnpm build:map`, `pnpm verify:map`.

## Web vs mobile builds

**Web** — standard Next.js server build. API routes in `src/app/api/` run in-process. Same-origin fetches (`/api/...`).

**Mobile** — `scripts/build-capacitor.ts`:

1. Temporarily moves `src/app/api/` aside (static export cannot include server routes)
2. Runs `next build` with `BUILD_TARGET=mobile` → `output: 'export'` into `out/`
3. Runs `cap sync` to copy `out/` into native projects
4. Restores API routes

Mobile apps call a **remote** backend via `NEXT_PUBLIC_API_URL` (see `src/lib/config.ts`). Set this to the Railway deployment URL when building for devices.

## Deployment (Railway)

The root `.railway/railway.ts` is the source of truth for the service source, build,
start, watch paths, preserved variables, and healthcheck. Apply it through the pinned
Railway CLI or the `railwayapp/config` PR workflow. Dashboard fields show the applied
state and should not be independently edited or cleared. See [Railway setup](../../.railway/README.md).
Dev uses service `apps/map` on `main`; production uses service `map` on `prod`. The
IaC definition selects both the service name and branch from the target environment.
Keep the repository root as the build context for workspace dependencies. Healthcheck:
`/api/health`.

Required runtime env vars on the server:

| Variable                | Purpose                          |
| ----------------------- | -------------------------------- |
| `DB_MAP_URL`            | PostgreSQL connection            |
| `THUNDERFOREST_API_KEY` | Premium basemap tiles (optional) |

## Dependencies

- `@lib/db-map` — database queries and API contract types
- `maplibre-gl` + `react-map-gl` — map rendering
- `@capacitor/*` — native shell plugins
- `@tanstack/react-query` — client data fetching

## Quirks

- Build fails if `@lib/db-map` contracts drift (`contracts:check` in build script).
- `tsconfig.json` maps `@/*` → `./src/*`; `scripts/` is excluded from typecheck.
- Capacitor live reload: uncomment `server.url` in `capacitor.config.ts` pointing at local dev server.
- Native folders are checked in — run `cap:sync` after web changes before opening Xcode/Android Studio.
