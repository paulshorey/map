# basemap/

Tile provider registry and UI for switching map styles. Providers are MapLibre-compatible vector URLs or inline raster style specs.

## Files

| File | Role |
| --- | --- |
| `providers.ts` | `PROVIDERS` array — id, label, tier, `getStyle()`, attribution, maxZoom |
| `useBasemap.ts` | Resolves active provider; handles switch + persistence |
| `BasemapSwitcher.tsx` | Floating picker overlay on the map |

## Provider tiers

- **free** — OpenFreeMap, Stadia, CARTO, OpenTopoMap (no API key in client)
- **premium** — Thunderforest raster tiles; requires server-fetched API key and `tier === 'premium'`

Default provider: `openfreemap-liberty`.

## Selection priority (`useBasemap`)

On first load, provider ID is chosen from (first match wins):

1. `?basemap=` query param (if allowed for tier)
2. `localStorage` key `basemap.providerId`
3. Server preference `user.preferences.basemapId`
4. `DEFAULT_PROVIDER_ID`

Switching basemaps updates localStorage, PATCHes preferences, sets query param, and **reloads the page** (`location.assign`). This avoids MapLibre style-swap edge cases.

## Adding a provider

1. Add entry to `PROVIDERS` in `providers.ts` with correct `tier` and `getStyle()`.
2. Add the ID to `FREE_PROVIDERS` or `PREMIUM_EXTRAS` in `@/lib/auth.ts` (server gate).
3. If premium and key-based, wire env var in `/api/providers/[providerId]/credentials/route.ts` and any `transformRequest` logic in `MapView.tsx` (Thunderforest appends `apikey` today).

## Quirks

- Stadia/CARTO/OpenFreeMap rely on referrer or public endpoints — no credentials route needed.
- Thunderforest keys are injected in `MapView` via `transformRequest`, not always embedded in the style URL.
- Locked providers still appear in the switcher UI with a lock icon.
