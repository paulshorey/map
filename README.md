# POI Map

A multi-provider interactive map application built with React, MapLibre GL JS, and PostGIS. Browse points of interest on a configurable basemap with clustering, viewport-driven loading, and a detail drawer.

## Features

- **14 basemap providers** — OpenFreeMap (default), Stadia Maps, Stamen Terrain, CARTO, OpenTopoMap, Thunderforest (premium)
- **Config-driven provider registry** — add a new provider by adding one object to an array
- **Viewport-driven POI loading** — debounced fetch on pan/zoom, backed by PostGIS spatial queries
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
| Database | PostgreSQL 16 + PostGIS 3.4                       |

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL 16+ with PostGIS extension

### 1. Install dependencies

```bash
npm install
```

### 2. Set up the database

```bash
# Create the database
createdb poi_map

# Run migrations (creates tables + indexes + guest user)
npm run migrate

# Seed sample data
npm run seed
```

### 3. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment Variables

| Variable                | Default                                                 | Description                                                                        |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DB_MAP_URL`            | `postgresql://postgres:postgres@localhost:5432/poi_map` | PostgreSQL connection string                                                       |
| `THUNDERFOREST_API_KEY` | —                                                       | Required for premium Thunderforest tiles                                           |
| `NEXT_PUBLIC_API_URL`   | —                                                       | Remote API origin for Capacitor mobile builds (e.g. `https://poi-map.example.com`) |

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
npm install
npm run cap:add:ios      # if ios/ does not exist yet
npm run cap:add:android  # if android/ does not exist yet
```

### Build for mobile

Set `NEXT_PUBLIC_API_URL` to your deployed backend, then sync:

```bash
NEXT_PUBLIC_API_URL=https://your-deployed-app.example.com npm run cap:sync
```

Open the native IDE:

```bash
npm run cap:ios       # builds, syncs, opens Xcode
npm run cap:android   # builds, syncs, opens Android Studio
```

### Live reload during development

1. Start the Next.js dev server: `npm run dev`
2. Uncomment the `server.url` block in `capacitor.config.ts` and set your machine's LAN IP (e.g. `http://192.168.1.10:3000`)
3. Run `npx cap run ios` or `npx cap run android`

The native app loads from your dev server instead of the static `out/` bundle.

### Scripts

| Script                 | Description                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `npm run build:mobile` | Static export to `out/` + `cap sync` (temporarily excludes `/api` routes from the build) |
| `npm run cap:sync`     | Alias for `build:mobile`                                                                 |
| `npm run cap:ios`      | Build, sync, open Xcode                                                                  |
| `npm run cap:android`  | Build, sync, open Android Studio                                                         |

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
├── src/
│   ├── app/
│   │   ├── layout.tsx            # Root layout + providers
│   │   ├── page.tsx              # Home page (dynamic map import)
│   │   ├── globals.css           # Tailwind + global styles
│   │   ├── providers.tsx         # QueryClient + AuthProvider
│   │   └── api/                  # Next.js Route Handlers
│   │       ├── pois/             # GET /api/pois, GET /api/pois/:id
│   │       ├── me/               # GET /api/me, PATCH /api/me/preferences
│   │       ├── providers/        # GET /api/providers/:id/credentials
│   │       └── health/           # GET /api/health
│   ├── auth/
│   │   ├── types.ts              # User, UserPreferences, UserTier types
│   │   ├── AuthContext.ts        # React context definition
│   │   ├── AuthProvider.tsx      # Context provider (fetches /api/me)
│   │   ├── useAuth.ts            # Hook to access auth context
│   │   ├── useEntitlements.ts    # Hook for tier + allowed providers
│   │   ├── usePremiumKey.ts      # Lazy-fetches credentials for premium providers
│   │   └── UserMenu.tsx          # User badge + dropdown menu
│   ├── basemap/
│   │   ├── providers.ts          # Provider registry (14 providers)
│   │   ├── useBasemap.ts         # Selection + persistence hook
│   │   └── BasemapSwitcher.tsx   # Dropdown UI
│   ├── map/
│   │   ├── MapView.tsx           # Main map component
│   │   ├── PoiLayer.tsx          # GeoJSON source + cluster layers
│   │   ├── PoiDrawer.tsx         # Detail side panel
│   │   └── usePoiSelection.ts   # Selection state
│   └── lib/
│       ├── db.ts                 # PostgreSQL pool (singleton)
│       ├── auth.ts               # resolveUserId + tier helpers
│       └── useDebouncedValue.ts
├── migrations/
│   ├── 0001_pois.sql             # POIs table + indexes
│   ├── 0002_users.sql            # Users + preferences tables + guest user
│   └── 0003_poi_details.sql      # POI address, website, hours columns
└── scripts/
    ├── migrate.ts                # Migration runner
    └── seed.ts                   # POI seed data
```

## Adding a New Provider

Add an entry to the `PROVIDERS` array in `src/basemap/providers.ts`:

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
2. **Update `resolveUserId()`** in `src/lib/auth.ts` to extract the real user ID from the request (JWT, session cookie, etc.)
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
