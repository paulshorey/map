---
name: map-ui-settings
description: Tune map UI behavior in apps/map — POI clustering, marker colors, cluster sizes, and related MapLibre layer settings. Use when the user wants to change how POIs group on the map, adjust clustering aggressiveness, show more individual points, or modify map overlay appearance.
---

# Map UI Settings

Tunable map overlay settings live in `apps/map/src/map/`. Clustering is client-side MapLibre; the API only returns POIs in the viewport bbox.

## POI clustering

**File:** `apps/map/src/map/PoiLayer.tsx` — `<Source id="pois">` props.

| Property           | Current | Effect                                                                                                                         |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `clusterRadius`    | `20`    | Screen-pixel radius for grouping. **Lower = less aggressive.** MapLibre default is 50. Try 20–35.                              |
| `clusterMaxZoom`   | `10`    | Above this zoom, clustering stops and individual points show. **Lower = uncluster sooner.** MapLibre default is 14. Try 11–13. |
| `clusterMinPoints` | `3`     | Minimum points to form a cluster. Default is 2; set to 3 so pairs of nearby POIs stay separate.                                |

**Less aggressive clustering** (more individual points, smaller groups):

```tsx
clusterRadius={25}
clusterMaxZoom={12}
clusterMinPoints={3}
```

**More aggressive clustering** (fewer, larger groups at wider zoom):

```tsx
clusterRadius={50}
clusterMaxZoom={14}
// omit clusterMinPoints (defaults to 2)
```

Cluster click-to-expand is handled in `MapView.tsx` via `getClusterExpansionZoom` on the `pois` source.

## Cluster circle size (visual only)

**File:** `PoiLayer.tsx` — `clusters` layer `circle-radius` paint. Does **not** affect grouping logic.

Current compact sizing — circles stay small and grow only enough for the count label:

```tsx
"circle-radius": ["step", ["get", "point_count"], 11, 10, 12, 100, 13, 1000, 14]
```

| Count   | Radius (px) |
| ------- | ----------- |
| 3–9     | 11          |
| 10–99   | 12          |
| 100–999 | 13          |
| 1000+   | 14          |

Use a **fixed** radius for uniform tiny clusters: `"circle-radius": 12`.

The count label size is separate — `cluster-count` layer `text-size` (currently `10`). If you shrink circles further, reduce `text-size` too so the number still fits.

Previous (large) sizing for reference: `16, 50, 22, 200, 28`.

## Map cursor

**File:** `MapView.tsx` — react-map-gl `Map` component.

The default cursor is **app-controlled**, not fixed by MapLibre. MapLibre's CSS sets `grab` on `.maplibre-gl-canvas`, but the Map `cursor` prop writes an inline style on the canvas and wins.

```tsx
const MAP_DEFAULT_CURSOR = "crosshair";
const POI_INTERACTIVE_LAYERS = ["clusters", "cluster-count", "poi-points"];

const [cursor, setCursor] = useState(MAP_DEFAULT_CURSOR);

const handleMouseMove = (e) => {
  setCursor(e.features?.length ? "pointer" : MAP_DEFAULT_CURSOR);
};

<Map
  cursor={cursor}
  onMouseMove={handleMouseMove}
  onMouseLeave={() => setCursor(MAP_DEFAULT_CURSOR)}
  onDragStart={() => setCursor("grabbing")}
  onDragEnd={() => setCursor(MAP_DEFAULT_CURSOR)}
  interactiveLayerIds={POI_INTERACTIVE_LAYERS}
/>;
```

Change `MAP_DEFAULT_CURSOR` to any CSS cursor value (`default`, `grab`, `crosshair`, etc.).

Include `cluster-count` in `interactiveLayerIds` so the count label shows `pointer` too (symbol layer sits above the circle).

| Cursor                | When                      |
| --------------------- | ------------------------- |
| `crosshair` (default) | Empty map — pan/zoom area |
| `pointer`             | Over POI or cluster       |
| `grabbing`            | Actively dragging the map |

## Single POI appearance

`poi-points` layer in `PoiLayer.tsx`:

- `POI_SINGLE_COLOR` — `#f7a917`
- `POI_CLUSTER_COLOR` — `#f4b644`
- `circle-radius`: 7

## What does not control clustering

- **API fetch limit** — `apps/map/src/app/api/pois/route.ts`: 500 POIs when zoom < 6, else 5000. Caps data returned, not grouping.
- **Bbox debounce** — `PoiLayer` debounces bbox 250ms before refetch.
- **No runtime UI** — clustering values are hardcoded constants, not user preferences.

## Related files

| File                         | Role                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| `PoiLayer.tsx`               | GeoJSON source, clustering props, layer paint                    |
| `MapView.tsx`                | Cluster click → zoom expansion; hover cursor; interactive layers |
| `apps/map/src/map/AGENTS.md` | Map module overview                                              |

## Tuning workflow

1. Edit clustering props in `PoiLayer.tsx`.
2. Run `pnpm dev` and pan/zoom to the dense region the user reported.
3. If clusters still merge too eagerly, lower `clusterRadius` or `clusterMaxZoom` further.
4. If the map feels cluttered, raise `clusterRadius` or `clusterMinPoints`.

---

# Maintain this skill

Update this file `.cursor/skills/map-ui-settings/SKILL.md` with other map settings and configurations that you come accross. Not only about POIs, but any map UI settings. Add more knowledge to this file as you think of more info.
