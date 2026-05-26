# apps/map/src

Next.js app source. The map is a single-page experience: one route, heavy client-side rendering.

## Layout

| Folder | Purpose |
| --- | --- |
| `app/` | Next.js App Router — layout, page, API routes |
| `auth/` | Client auth context, user menu, entitlements |
| `basemap/` | Tile provider registry and basemap switcher |
| `map/` | MapLibre map, POI layers, selection drawer |
| `lib/` | Shared helpers (API URLs, server auth, platform) |
| `components/` | Cross-cutting UI (Capacitor native init) |

## Path alias

Imports use `@/` → `apps/map/src/` (e.g. `@/map/MapView`, `@/lib/config`).

## Key flows

1. **Boot** — `app/layout.tsx` wraps the tree in React Query + `AuthProvider`. `page.tsx` renders `MapClient`, which dynamically imports `MapView` with `ssr: false` (MapLibre needs the browser).
2. **Data** — POIs and user prefs go through `/api/*` routes, which call `@lib/db-map` SQL helpers.
3. **Mobile** — Capacitor builds set `NEXT_PUBLIC_API_URL` so the native shell talks to a remote API; web uses same-origin paths via `apiUrl()`.

## Quirks

- Almost all map UI is `'use client'`. Server components are limited to layout/page shells.
- Guest auth only today: `resolveUserId()` in `lib/auth.ts` always returns `'guest'`.
- Do not import MapLibre in server components — use the dynamic import pattern in `map-client.tsx`.
