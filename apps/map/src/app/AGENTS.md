# app/

Next.js App Router entry point and REST API for the map app.

## Pages & layout

| File | Role |
| --- | --- |
| `layout.tsx` | Root HTML shell, metadata, global CSS, `<Providers>` |
| `page.tsx` | Home route — full-screen `<MapClient />` |
| `map-client.tsx` | Dynamic import of `MapView` (no SSR) with loading spinner |
| `providers.tsx` | React Query + `AuthProvider` + `CapacitorInit` |
| `globals.css` | Tailwind v4 base styles |

## API routes (`app/api/`)

All routes use `@lib/db-map` for database access. Types for request/response shapes live in `lib/db-map/contracts/map-app.ts`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/health` | GET | Liveness check |
| `/api/me` | GET | Current user, tier, allowed basemaps, saved preferences |
| `/api/me/preferences` | PATCH | Persist basemap choice and last map viewport |
| `/api/pois` | GET | GeoJSON FeatureCollection for viewport bbox (`?bbox=w,s,e,n&zoom=N`) |
| `/api/pois/[id]` | GET | Full POI detail for the side drawer |
| `/api/providers/[providerId]/credentials` | GET | Premium tile API keys (403 for free tier) |

## Conventions

- User identity comes from `resolveUserId()` in `@/lib/auth` — currently hardcoded `'guest'`.
- POI list limits scale with zoom (500 at low zoom, 5000 otherwise); world-view bboxes skip spatial filter.
- Provider credentials are server-side only — keys never ship in client bundles except via this endpoint for premium users.

## Adding routes

New API routes belong here under `app/api/`. Prefer reusing `@lib/db-map` SQL functions rather than inline queries. If the response shape is part of the app contract, update `lib/db-map/contracts/map-app.ts` and run `pnpm db:sync` / contract generation as needed.
