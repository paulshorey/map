# map/

Interactive MapLibre map — basemap, clustered POI overlay, click-to-detail drawer.

## Files

| File                      | Role                                                                        |
| ------------------------- | --------------------------------------------------------------------------- |
| `MapView.tsx`             | Main map component — controls, layers, click handling, viewport persistence |
| `PoiLayer.tsx`            | GeoJSON source with clustering; renders the list MapView passes in          |
| `usePoiList.ts`           | Debounced `/api/pois` query: features plus `total` / `returned` counts      |
| `usePoiLocationFilter.ts` | General / All / Precise choice, persisted in `localStorage`                 |
| `PoiFilterBar.tsx`        | Location filter control and the always-visible result count                 |
| `PoiDrawer.tsx`           | Right-side panel: every POI at the clicked point, clicked POI first         |
| `usePoiSelection.ts`      | Selected marker, co-located fetch, MapLibre feature-state highlight         |

## Stack

- **react-map-gl** + **maplibre-gl** (not Mapbox GL)
- **@tanstack/react-query** for POI list and detail caching
- Hooks from `../basemap`, `../auth`, `../lib`

## Data flow

1. `MapView` tracks bbox/zoom on `onLoad` / `onMoveEnd`.
2. `usePoiList` debounces bbox (250ms) and GETs `/api/pois?bbox=...&zoom=...[&category=...][&location=general|precise]`.
   `MapView` passes the features to `PoiLayer` (clustered circles) and `total` / `returned` to the
   result count. `total` counts every matching POI, even beyond the 500/5000 marker limit.
3. Click on cluster → expand zoom; click on point → `selectPoi(id, location_id)` →
   GET `/api/pois/[id]/colocated?location=` → `PoiDrawer`. The response lists every published POI
   with a marker at the clicked marker's exact point (±1e-7°), clicked POI first, ignoring the
   category/location/date filters. One POI renders as before; several render as a scrollable
   list of cards (`N places at this location`). `GET /api/pois/[id]` still returns one POI.
4. Viewport center/zoom debounced 2s → `updatePreferences` (saved to DB for guest user).

## MapLibre layers

Source id: `pois`. Interactive layers: `clusters`, `poi-points`. Feature state `selected` drives opacity on the active point.

Each POI has one Point feature per known location (`canonical_poi_locations`). `properties.id` is
the shared detail/POI ID; `properties.marker_id` (`<POI>:<location id>`, or `<POI>:legacy` without
stored locations) is the unique promoted feature-state ID and `properties.location_id` the location.
Never use the shared POI ID as a feature ID. Every location opens the same drawer,
which lists them all with provenance; the API filters each location by viewport. Entity limits
count POIs, and cluster counts are marker counts. Details retain fixed source/inferred origin and precision for both.
`coordinate_evidence` contains independently nullable source_coordinates and
inferred_coordinates; location order is not provenance. Equal values retain both
evidence records while one marker is rendered. Physical roles are not assumed.

## Stacked and general markers

`MapView` adds `stack_count` (loaded markers sharing an exact point) to each feature;
`poi-stack-count` labels stacks above one. Markers are hollow when the POI is flagged
`general` or the marker's precision is coarser than `point`. Each drawer card shows a
`General location` badge and the contributing source names (developer debugging aids).

## Location filter

`location=general` shows only POIs whose canonical build flagged
`attributes.location_specificity = 'general'` (located just by country, region or city);
`location=precise` shows every other POI, including legacy builds without the flag. The
drawer notes a general location. The flag is set at canonical build time (existing builds
keep theirs until rebuilt).

## Review filter

`review=<flag>` (the "Review" dropdown, `usePoiReviewFilter`) shows only POIs carrying that
`canonical_pois.review_flags` entry: `general_location`, `source_needs_review`, and flags added
later in `lib/db-map/sql/review-flags.ts` (add a label in `REVIEW_FLAG_LABELS`). Flags are
derived: each rebuild refreshes its POI, migration `202611060710` backfilled existing POIs, and
`ingest:review-flags --refresh` recomputes all. The drawer lists a POI's flags.

## Quirks

- Waits for auth loading before rendering the map (needs preferences for initial view).
- `initialViewState` comes from user prefs or defaults (center `[10, 20]`, zoom 2).
- Premium Thunderforest tiles: `transformRequest` appends `apikey` when missing from tile URLs.
- `MapView` must only load client-side — see dynamic import in `app/map-client.tsx`.
- `PoiDetail` type in `usePoiSelection.ts` is client-local; API rows follow `PoiDetailRecord` from db-map contracts.
