# map/

Interactive MapLibre map — basemap, clustered POI overlay, click-to-detail drawer.

## Files

| File | Role |
| --- | --- |
| `MapView.tsx` | Main map component — controls, layers, click handling, viewport persistence |
| `PoiLayer.tsx` | GeoJSON source with clustering; fetches POIs for current bbox |
| `PoiDrawer.tsx` | Right-side panel showing selected POI details |
| `usePoiSelection.ts` | Selected POI state, detail fetch, MapLibre feature-state highlight |

## Stack

- **react-map-gl** + **maplibre-gl** (not Mapbox GL)
- **@tanstack/react-query** for POI list and detail caching
- Hooks from `../basemap`, `../auth`, `../lib`

## Data flow

1. `MapView` tracks bbox/zoom on `onLoad` / `onMoveEnd`.
2. `PoiLayer` debounces bbox (250ms), GETs `/api/pois?bbox=...&zoom=...`, renders clustered circles.
3. Click on cluster → expand zoom; click on point → `selectPoi(id)` → GET `/api/pois/[id]` → `PoiDrawer`.
4. Viewport center/zoom debounced 2s → `updatePreferences` (saved to DB for guest user).

## MapLibre layers

Source id: `pois`. Interactive layers: `clusters`, `poi-points`. Feature state `selected` drives opacity on the active point.

## Quirks

- Waits for auth loading before rendering the map (needs preferences for initial view).
- `initialViewState` comes from user prefs or defaults (center `[10, 20]`, zoom 2).
- Premium Thunderforest tiles: `transformRequest` appends `apikey` when missing from tile URLs.
- `MapView` must only load client-side — see dynamic import in `app/map-client.tsx`.
- `PoiDetail` type in `usePoiSelection.ts` is client-local; API rows follow `PoiDetailRecord` from db-map contracts.
