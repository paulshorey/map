# POI Map

A multi-provider interactive map application built with React, MapLibre GL JS, and PostGIS. Browse points of interest on a configurable basemap with clustering, viewport-driven loading, and a detail drawer.

## Features

- **14 basemap providers** — OpenFreeMap (default), Stadia Maps, Stamen Terrain, CARTO, OpenTopoMap, Thunderforest (premium)
- **Config-driven provider registry** — add a new provider by adding one object to an array
- **Viewport-driven POI loading** — debounced fetch on pan/zoom, backed by PostGIS spatial queries
- **Built-in clustering** — MapLibre's native supercluster with expandable clusters
- **POI detail drawer** — click a point to see name, category, description
- **Provider persistence** — choice saved to `localStorage` + URL `?basemap=` param
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

# Run migrations (creates tables + indexes)
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

## Project Structure

```
├── src/
│   ├── basemap/
│   │   ├── providers.ts          # Provider registry (14 providers)
│   │   ├── useBasemap.ts         # Selection + persistence hook
│   │   └── BasemapSwitcher.tsx   # Dropdown UI
│   ├── map/
│   │   ├── MapView.tsx           # Main map component
│   │   ├── PoiLayer.tsx          # GeoJSON source + cluster layers
│   │   ├── PoiDrawer.tsx         # Detail side panel
│   │   └── usePoiSelection.ts   # Selection state
│   ├── auth/
│   │   ├── useEntitlements.ts    # Stub (wire to real auth later)
│   │   └── usePremiumKey.ts      # Stub (wire to credentials endpoint)
│   └── lib/
│       └── useDebouncedValue.ts
├── server/
│   ├── src/
│   │   ├── index.ts              # Fastify entry point
│   │   ├── db.ts                 # PostgreSQL pool
│   │   ├── routes/pois.ts        # GET /pois, GET /pois/:id
│   │   ├── routes/me.ts          # GET /me (stub)
│   │   └── routes/credentials.ts # GET /providers/:id/credentials (stub)
│   ├── migrations/
│   │   └── 0001_pois.sql
│   └── src/seed.ts
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

To change the default, set `DEFAULT_PROVIDER_ID`.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/pois?bbox=w,s,e,n&zoom=N&category=X` | POIs in bounding box (GeoJSON) |
| `GET` | `/pois/:id` | POI detail |
| `GET` | `/me` | User profile + allowed providers |
| `GET` | `/providers/:id/credentials` | Provider API key (premium only) |
| `GET` | `/health` | Health check |
