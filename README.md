# POI Map

A multi-provider interactive map application built with React, MapLibre GL JS, and PostgreSQL. Browse points of interest on a configurable basemap with clustering, viewport-driven loading, and a detail drawer.

## Features

- **14 basemap providers** — OpenFreeMap (default), Stadia Maps, Stamen Terrain, CARTO, OpenTopoMap, Thunderforest (premium)
- **Config-driven provider registry** — add a new provider by adding one object to an array
- **Viewport-driven POI loading** — debounced fetch on pan/zoom, backed by bounding box spatial queries
- **Built-in clustering** — MapLibre's native supercluster with expandable clusters
- **POI detail drawer** — click a point to see name, category, description
- **Provider persistence** — choice saved to server, `localStorage`, and URL `?basemap=` param
- **Guest user by default** — no login required; map loads immediately with a mock guest account. Preferences (basemap choice, viewport position) are persisted server-side. When real auth is added, guest preferences merge into the new account.
- **Reload-on-switch** — simplest strategy, avoids `setStyle()` edge cases

## Tech Stack

| Layer    | Technology                                        |
| -------- | ------------------------------------------------- |
| App      | Next.js 15, React 19, TypeScript, Tailwind CSS v4 |
| Map      | MapLibre GL JS 5.24, react-map-gl/maplibre 8.x    |
| Data     | TanStack Query 5                                  |
| Database | PostgreSQL 16+ with `pg_trgm`                       |

## Monorepo Layout

```
├── apps/
│   └── map/              # Next.js + Capacitor POI map app
├── lib/
│   ├── config/           # Shared TypeScript configs
│   └── db-map/           # Database migrations, contracts, SQL layer
├── scripts/              # Repo-level helper scripts
├── package.json          # Root workspace scripts
├── pnpm-workspace.yaml
└── turbo.json
```

## Quick Start

### Prerequisites

- Node.js 20+
- pnpm 10+
- PostgreSQL 16+

### 1. Install dependencies

```bash
pnpm install
```

### 2. Set up the database

```bash
pnpm --filter @lib/db-map db:migrate
```

`DB_MAP_URL` must already be present in the shell environment. This repo does not use `.env`
files; `.env.example` is only a reference list of expected variables.

After a schema change, run the full sync and commit the generated files:

```bash
cd lib/db-map && pnpm db:sync
```

### 3. Start the dev server

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment Variables

| Variable                | Default                                                 | Description                                                                        |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DB_MAP_URL`            | `postgresql://postgres:postgres@localhost:5432/poi_map` | PostgreSQL connection string (used by `@lib/db-map`)                             |
| `THUNDERFOREST_API_KEY` | —                                                       | Required for premium Thunderforest tiles                                           |
| `NEXT_PUBLIC_API_URL`   | —                                                       | Remote API origin for Capacitor mobile builds (e.g. `https://poi-map.example.com`) |

### Database commands

| Command                  | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `pnpm db:migrate`        | Apply pending migrations                         |
| `pnpm db:migrate:baseline` | Mark baseline migration applied (legacy DBs)   |
| `pnpm db:verify`         | Migrate, regenerate types/contracts, assert schema |
| `pnpm db:seed`           | Seed sample POI data                             |

## POI Ingestion

Use the staged ingestion pipeline for real POI data. It keeps raw source rows in
`research_pois`, then conflates them into user-facing `canonical_pois`.

Common source workflow:

```bash
pnpm --filter @lib/db-map ingest:taxonomy:seed
pnpm --filter @lib/db-map ingest:run <file> --category <category-slug>
```

Or run stages individually:

```bash
pnpm --filter @lib/db-map ingest:extract <source-slug> <file> --category <category-slug>
pnpm --filter @lib/db-map ingest:normalize [--source <source-slug>]
pnpm --filter @lib/db-map ingest:geocode [--source <source-slug>] [--geocode-limit 4500]
pnpm --filter @lib/db-map ingest:embed [--source <source-slug>]
pnpm --filter @lib/db-map ingest:match --consolidate
```

`ingest:run` and `ingest:extract` both require `--category`; category is never inferred from
the file path or raw data. Repeat `--category` to tag every record with multiple categories
(the first flag is the primary category), for example:

```bash
pnpm --filter @lib/db-map ingest:run \
  docs/poi/art-fairs/craft-shows/festivalnet.json \
  --category art_fair --category craft_fair --category renaissance_fair
```

Useful match commands:

```bash
# Resume safely; skips rows already linked to canonicals.
pnpm --filter @lib/db-map ingest:match --consolidate

# Process in smaller chunks.
pnpm --filter @lib/db-map ingest:match --limit 500

# Clean up already-created canonicals without processing more raw rows.
pnpm --filter @lib/db-map ingest:match --consolidate-only
pnpm --filter @lib/db-map ingest:match --consolidate-only --dry-run

# Start over from raw research rows. Destructive; use only when intentional.
pnpm --filter @lib/db-map ingest:match --recluster --consolidate
```

`ingest:match` prints linked/pending counts at startup. First `Ctrl-C` stops after the
current unit and prints a resume command; second `Ctrl-C` exits immediately.

Check pipeline state at any time with the read-only report:

```bash
pnpm --filter @lib/db-map ingest:report [--source <slug>] [--category <slug>]
```

Re-importing a source file is idempotent: unchanged records keep their canonical links and
are skipped; only new or changed records flow through the pipeline again.

Deep-dive docs: [`docs/poi-ingestion.md`](docs/poi-ingestion.md). Raw data capture format
for new sources: [`docs/poi-research/capture-spec.md`](docs/poi-research/capture-spec.md).

## Mobile (Capacitor)

This app supports **web**, **iOS**, and **Android** from one codebase using [Capacitor 8](https://capacitorjs.com/).

### How it differs from Vite + Capacitor

Your Vite app (`gopass/apps/webapp`) builds a static `dist/` folder that Capacitor wraps in a native WebView. Next.js can do the same, but with an important constraint:

|                   | Vite + Capacitor                       | Next.js + Capacitor                                  |
| ----------------- | -------------------------------------- | ---------------------------------------------------- |
| Build output      | `dist/`                                | `out/` (static export)                               |
| API routes        | External backend (`VITE_API_BASE_URL`) | Same — API routes cannot run inside the native shell |
| Web deployment    | Static hosting                         | Full Next.js server (`npm run build && npm start`)   |
| Mobile deployment | `cap sync` copies static assets        | Same workflow                                        |

Capacitor has **no Node.js server at runtime** — only static HTML/JS/CSS in a WebView. The Next.js `/api/*` route handlers stay on a deployed server; the mobile app calls them via `NEXT_PUBLIC_API_URL`.

### Prerequisites

- Xcode (iOS) and/or Android Studio (Android)
- A deployed instance of this app (or local dev server) for the mobile app to reach `/api/*`

### One-time setup

```bash
pnpm install
pnpm --filter map cap:add:ios      # if ios/ does not exist yet
pnpm --filter map cap:add:android  # if android/ does not exist yet
```

### Build for mobile

Set `NEXT_PUBLIC_API_URL` to your deployed backend, then sync:

```bash
NEXT_PUBLIC_API_URL=https://your-deployed-app.example.com pnpm --filter map cap:sync
```

Open the native IDE:

```bash
pnpm --filter map cap:ios       # builds, syncs, opens Xcode
pnpm --filter map cap:android   # builds, syncs, opens Android Studio
```

### Live reload during development

1. Start the Next.js dev server: `pnpm dev`
2. Uncomment the `server.url` block in `capacitor.config.ts` and set your machine's LAN IP (e.g. `http://192.168.1.10:3000`)
3. Run `npx cap run ios` or `npx cap run android`

The native app loads from your dev server instead of the static `out/` bundle.

### Scripts

| Script                          | Description                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm --filter map build:mobile` | Static export to `out/` + `cap sync` (temporarily excludes `/api` routes from the build) |
| `pnpm --filter map cap:sync`     | Alias for `build:mobile`                                                                 |
| `pnpm --filter map cap:ios`      | Build, sync, open Xcode                                                                  |
| `pnpm --filter map cap:android`  | Build, sync, open Android Studio                                                         |

## Architecture

### Authentication Flow

The app uses a **guest-first** approach:

1. On first visit, the frontend calls `GET /api/me`, which returns the built-in `guest` user
2. The guest user has `tier: "free"` with access to all free basemap providers
3. User preferences (basemap choice, last viewport) are persisted to the database via `PATCH /api/me/preferences`
4. No login screen is shown — the map loads immediately
5. When real auth is added later (Supabase Auth, Clerk, etc.), the `resolveUserId()` function in `src/lib/auth.ts` switches from returning `'guest'` to extracting the real user ID from a JWT/session cookie
6. Guest preferences can be merged into the authenticated user's profile at that point

### Entitlement Model

Provider access is gated by a `tier` column on the `users` table:

- **Free tier:** All OpenFreeMap, Stadia, CARTO, and OpenTopoMap providers
- **Premium tier:** Free providers + Thunderforest Outdoors/Landscape

The server computes `allowedProviders` from the tier and returns it in `/api/me`. The client never decides access — it renders what the server allows.

## Project Structure

```
├── apps/map/
│   ├── src/
│   │   ├── app/                  # Next.js App Router + API routes
│   │   ├── auth/                 # Client auth context + hooks
│   │   ├── basemap/              # Provider registry + switcher
│   │   ├── map/                  # MapLibre UI components
│   │   └── lib/                  # App helpers (auth, config)
│   ├── ios/, android/            # Capacitor native shells
│   └── scripts/build-capacitor.ts
├── lib/db-map/
│   ├── migrations/               # Forward-only SQL migrations
│   ├── contracts/map-app.ts      # App-facing TypeScript contracts
│   ├── generated/                # Auto-generated types + JSON schemas
│   ├── sql/                      # Shared SQL query modules
│   └── scripts/                  # migrate, verify, seed tooling
└── scripts/                      # Repo-level helpers
```

## Adding a New Provider

Add an entry to the `PROVIDERS` array in `apps/map/src/basemap/providers.ts`:

```ts
{
  id: 'my-provider',
  label: 'My Provider',
  kind: 'vector',        // or 'raster'
  tier: 'free',           // or 'premium'
  maxZoom: 20,
  attribution: '© ...',
  getStyle: () => 'https://tiles.example.com/styles/my-style.json',
}
```

To change the default, update `DEFAULT_PROVIDER_ID`.

## Wiring Real Authentication

When you're ready to add real auth, the changes are minimal:

1. **Install your auth provider** (Supabase Auth, Clerk, etc.)
2. **Update `resolveUserId()`** in `apps/map/src/lib/auth.ts` to extract the real user ID from the request (JWT, session cookie, etc.)
3. **Create real users** in the `users` table when they sign up
4. **Merge guest preferences** into the new user's row on first login
5. **Update `AuthProvider.tsx`** to include auth headers in the `/api/me` fetch

The frontend auth hooks (`useAuth`, `useEntitlements`, `usePremiumKey`) already work with the server response shape — no changes needed.

## API Endpoints

| Method  | Path                                       | Description                                           |
| ------- | ------------------------------------------ | ----------------------------------------------------- |
| `GET`   | `/api/pois?bbox=w,s,e,n&zoom=N&category=X` | POIs in bounding box (GeoJSON)                        |
| `GET`   | `/api/pois/:id`                            | POI detail                                            |
| `GET`   | `/api/me`                                  | User profile + tier + allowed providers + preferences |
| `PATCH` | `/api/me/preferences`                      | Update user preferences (basemap, viewport)           |
| `GET`   | `/api/providers/:id/credentials`           | Provider API key (premium only, 403 for free)         |
| `GET`   | `/api/health`                              | Health check                                          |
