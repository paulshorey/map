import type { StyleSpecification } from 'maplibre-gl';

export type ProviderTier = 'free' | 'premium';

export interface BasemapProvider {
  id: string;
  label: string;
  description?: string;
  kind: 'vector' | 'raster';
  tier: ProviderTier;
  maxZoom: number;
  attribution: string;
  getStyle(creds?: ProviderCredentials): string | StyleSpecification;
  docsUrl?: string;
}

export interface ProviderCredentials {
  apiKey?: string;
}

function rasterStyle(
  tiles: string[],
  attribution: string,
  tileSize = 256,
  maxzoom = 19,
): StyleSpecification {
  return {
    version: 8,
    sources: {
      'raster-basemap': {
        type: 'raster',
        tiles,
        tileSize,
        maxzoom,
        attribution,
      },
    },
    layers: [
      {
        id: 'raster-basemap',
        type: 'raster',
        source: 'raster-basemap',
      },
    ],
  };
}

export const PROVIDERS: BasemapProvider[] = [
  // ── OpenFreeMap (default) ─────────────────────────────────────
  {
    id: 'openfreemap-liberty',
    label: 'OpenFreeMap Liberty',
    description: 'Clean OSM vector tiles — no API key, no limits.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 19,
    attribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
    getStyle: () => 'https://tiles.openfreemap.org/styles/liberty',
    docsUrl: 'https://openfreemap.org/',
  },
  {
    id: 'openfreemap-positron',
    label: 'OpenFreeMap Positron',
    description: 'Light, muted base ideal for data overlays.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 19,
    attribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
    getStyle: () => 'https://tiles.openfreemap.org/styles/positron',
    docsUrl: 'https://openfreemap.org/',
  },
  {
    id: 'openfreemap-bright',
    label: 'OpenFreeMap Bright',
    description: 'Vivid, colorful OSM style.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 19,
    attribution: 'OpenFreeMap © OpenMapTiles Data from OpenStreetMap',
    getStyle: () => 'https://tiles.openfreemap.org/styles/bright',
    docsUrl: 'https://openfreemap.org/',
  },

  // ── Stadia Maps (domain auth, no key in code) ────────────────
  {
    id: 'stadia-outdoors',
    label: 'Stadia Outdoors',
    description: 'Vector map highlighting mountains, parks, trails.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 20,
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    getStyle: () => 'https://tiles.stadiamaps.com/styles/outdoors.json',
    docsUrl: 'https://docs.stadiamaps.com/map-styles/outdoors/',
  },
  {
    id: 'stamen-terrain',
    label: 'Stamen Terrain',
    description: 'Hillshaded terrain with classic Stamen styling.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 18,
    attribution:
      '© Stadia Maps © Stamen Design © OpenMapTiles © OpenStreetMap contributors',
    getStyle: () => 'https://tiles.stadiamaps.com/styles/stamen_terrain.json',
    docsUrl: 'https://docs.stadiamaps.com/map-styles/stamen-terrain/',
  },
  {
    id: 'alidade-satellite',
    label: 'Alidade Satellite',
    description: 'Satellite imagery with labels.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 20,
    attribution:
      '© CNES, Distribution Airbus DS, © Airbus DS, © PlanetObserver (Contains Copernicus Data) | © Stadia Maps © OpenMapTiles © OpenStreetMap',
    getStyle: () =>
      'https://tiles.stadiamaps.com/styles/alidade_satellite.json',
    docsUrl: 'https://docs.stadiamaps.com/map-styles/alidade-satellite/',
  },
  {
    id: 'alidade-smooth',
    label: 'Alidade Smooth',
    description: 'Muted base ideal for data overlays.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 20,
    attribution: '© Stadia Maps © OpenMapTiles © OpenStreetMap contributors',
    getStyle: () => 'https://tiles.stadiamaps.com/styles/alidade_smooth.json',
  },

  // ── CARTO ─────────────────────────────────────────────────────
  {
    id: 'carto-voyager',
    label: 'CARTO Voyager',
    description: 'Versatile base with muted colors.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 20,
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    getStyle: () =>
      'https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json',
  },
  {
    id: 'carto-positron',
    label: 'CARTO Positron',
    description: 'Light minimal base.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 20,
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    getStyle: () =>
      'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  },
  {
    id: 'carto-dark-matter',
    label: 'CARTO Dark Matter',
    description: 'Dark base for night/data visualization.',
    kind: 'vector',
    tier: 'free',
    maxZoom: 20,
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    getStyle: () =>
      'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
  },

  // ── OpenTopoMap ───────────────────────────────────────────────
  {
    id: 'opentopomap',
    label: 'OpenTopoMap',
    description: 'Topographic contour lines + hillshading.',
    kind: 'raster',
    tier: 'free',
    maxZoom: 17,
    attribution:
      'Map data: © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
    getStyle: () =>
      rasterStyle(
        [
          'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
          'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
        ],
        'Map data © OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
        256,
        17,
      ),
  },

  // ── Thunderforest (premium, requires API key) ─────────────────
  {
    id: 'thunderforest-outdoors',
    label: 'Thunderforest Outdoors',
    description: 'Detailed hiking/outdoor raster map (premium).',
    kind: 'raster',
    tier: 'premium',
    maxZoom: 22,
    attribution:
      'Maps © <a href="https://www.thunderforest.com">Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    getStyle: (creds) =>
      rasterStyle(
        [
          `https://tile.thunderforest.com/outdoors/{z}/{x}/{y}@2x.png?apikey=${creds?.apiKey ?? ''}`,
        ],
        'Maps © Thunderforest, Data © OpenStreetMap contributors',
        256,
        22,
      ),
    docsUrl: 'https://www.thunderforest.com/maps/outdoors/',
  },
  {
    id: 'thunderforest-landscape',
    label: 'Thunderforest Landscape',
    description: 'Landscape-focused raster map (premium).',
    kind: 'raster',
    tier: 'premium',
    maxZoom: 22,
    attribution:
      'Maps © Thunderforest, Data © OpenStreetMap contributors',
    getStyle: (creds) =>
      rasterStyle(
        [
          `https://tile.thunderforest.com/landscape/{z}/{x}/{y}@2x.png?apikey=${creds?.apiKey ?? ''}`,
        ],
        'Maps © Thunderforest, Data © OpenStreetMap contributors',
        256,
        22,
      ),
  },
];

export const DEFAULT_PROVIDER_ID = 'openfreemap-liberty';

export function getProvider(id: string): BasemapProvider {
  return (
    PROVIDERS.find((p) => p.id === id) ??
    PROVIDERS.find((p) => p.id === DEFAULT_PROVIDER_ID)!
  );
}
