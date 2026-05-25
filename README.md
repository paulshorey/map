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
| Database | PostgreSQL 16+ (no extensions required)            |

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
# Create the database
createdb poi_map

# Copy env and set DB_MAP_URL
cp .env.example .env

# Run migrations (creates tables + indexes + guest user)
pnpm db:migrate

# Seed sample data
pnpm db:seed
```

If the database already has the schema from an earlier version of this project, mark the baseline migration as applied instead:

```bash
pnpm db:migrate:baseline
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
