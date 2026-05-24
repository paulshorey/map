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

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite 8, Tailwind CSS v4 |
| Map | MapLibre GL JS 5.24, react-map-gl/maplibre 8.x |
| Data | TanStack Query 5 |
| Backend | Node 22, Fastify 5 |
| Database | PostgreSQL 16 + PostGIS 3.4 |

## Quick Start

### Prerequisites

- Node.js 22+
- PostgreSQL 16+ with PostGIS extension

### 1. Install dependencies

```bash
npm install
cd server && npm install && cd ..
```

### 2. Set up the database

```bash
# Create the database
createdb poi_map

# Run migrations (creates tables + indexes + guest user)
cd server && npm run migrate

# Seed sample data (~1000 POIs across 22 cities)
npm run seed
cd ..
```

### 3. Start the servers

```bash
# Terminal 1: API server (port 3000)
cd server && npm run dev

# Terminal 2: Frontend dev server (port 5173, proxies /api to :3000)
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/poi_map` | PostgreSQL connection string |
| `PORT` | `3000` | API server port |
| `THUNDERFOREST_API_KEY` | — | Required for premium Thunderforest tiles |

## Architecture

### Authentication Flow

The app uses a **guest-first** approach:

1. On first visit, the frontend calls `GET /api/me`, which returns the built-in `guest` user
2. The guest user has `tier: "free"` with access to all free basemap providers
3. User preferences (basemap choice, last viewport) are persisted to the database via `PATCH /api/me/preferences`
4. No login screen is shown — the map loads immediately
5. When real auth is added later (Supabase Auth, Clerk, etc.), the `resolveUserId()` function in each route switches from returning `'guest'` to extracting the real user ID from a JWT/session cookie
6. Guest preferences can be merged into the authenticated user's profile at that point

### Entitlement Model

Provider access is gated by a `tier` column on the `users` table:

- **Free tier:** All OpenFreeMap, Stadia, CARTO, and OpenTopoMap providers
- **Premium tier:** Free providers + Thunderforest Outdoors/Landscape

The server computes `allowedProviders` from the tier and returns it in `/api/me`. The client never decides access — it renders what the server allows.

## Project Structure

```
├── src/
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
│       └── useDebouncedValue.ts
├── server/
│   ├── src/
│   │   ├── index.ts              # Fastify entry point
│   │   ├── db.ts                 # PostgreSQL pool
│   │   ├── routes/pois.ts        # GET /pois, GET /pois/:id
│   │   ├── routes/me.ts          # GET /me, PATCH /me/preferences
│   │   └── routes/credentials.ts # GET /providers/:id/credentials
│   ├── migrations/
│   │   ├── 0001_pois.sql         # POIs table + indexes
│   │   └── 0002_users.sql        # Users + preferences tables + guest user
│   └── src/seed.ts               # POI seed data
└── .cursor/plans/
    └── new-map-app.md            # Full implementation plan
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
2. **Update `resolveUserId()`** in `server/src/routes/me.ts` and `credentials.ts` to extract the real user ID from the request (JWT, session cookie, etc.)
3. **Create real users** in the `users` table when they sign up
4. **Merge guest preferences** into the new user's row on first login
5. **Update `AuthProvider.tsx`** to include auth headers in the `/api/me` fetch

The frontend auth hooks (`useAuth`, `useEntitlements`, `usePremiumKey`) already work with the server response shape — no changes needed.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/pois?bbox=w,s,e,n&zoom=N&category=X` | POIs in bounding box (GeoJSON) |
| `GET` | `/pois/:id` | POI detail |
| `GET` | `/me` | User profile + tier + allowed providers + preferences |
| `PATCH` | `/me/preferences` | Update user preferences (basemap, viewport) |
| `GET` | `/providers/:id/credentials` | Provider API key (premium only, 403 for free) |
| `GET` | `/health` | Health check |
