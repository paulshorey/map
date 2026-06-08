'use client';

import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import {
  Map,
  NavigationControl,
  GeolocateControl,
  AttributionControl,
  type MapRef,
  type MapLayerMouseEvent,
} from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useRef, useCallback, useState, useMemo, useEffect } from 'react';
import { useBasemap } from '../basemap/useBasemap';
import { useAuth } from '../auth/useAuth';
import { usePremiumKey } from '../auth/usePremiumKey';
import { UserMenu } from '../auth/UserMenu';
import { BasemapSwitcher } from '../basemap/BasemapSwitcher';
import { CategorySwitcher } from './CategorySwitcher';
import { PoiLayer, type Bbox } from './PoiLayer';
import { usePoiCategory } from './usePoiCategory';
import { PoiDrawer } from './PoiDrawer';
import { usePoiSelection } from './usePoiSelection';
import { useDebouncedValue } from '../lib/useDebouncedValue';

const DEFAULT_CENTER: [number, number] = [10, 20];
const DEFAULT_ZOOM = 2;
const POI_INTERACTIVE_LAYERS = ['clusters', 'cluster-count', 'poi-points'];
const MAP_DEFAULT_CURSOR = 'crosshair';

/**
 * Reduce prominence of country/city/place labels on vector basemaps.
 * Targets symbol layers whose id suggests they render place names.
 */
/** Collapse compact attribution to the info icon (MapLibre defaults to expanded). */
function collapseAttribution(map: maplibregl.Map): boolean {
  const el = map
    .getContainer()
    .querySelector<HTMLDetailsElement>('.maplibregl-ctrl-attrib.maplibregl-compact');
  if (!el?.classList.contains('maplibregl-compact-show')) return !!el;
  el.classList.remove('maplibregl-compact-show');
  el.setAttribute('open', '');
  return true;
}

function softenLabels(map: maplibregl.Map) {
  const style = map.getStyle();
  if (!style?.layers) return;

  const placeLabelPattern =
    /place|country|city|town|village|state|capital|continent|label|locality/i;

  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue;
    if (!placeLabelPattern.test(layer.id)) continue;

    const currentSize = map.getLayoutProperty(layer.id, 'text-size');
    if (currentSize != null) {
      if (typeof currentSize === 'number') {
        map.setLayoutProperty(layer.id, 'text-size', Math.round(currentSize * 0.7));
      } else if (typeof currentSize === 'object' && currentSize.stops) {
        const scaled = {
          ...currentSize,
          stops: currentSize.stops.map((s: [number, number]) => [s[0], Math.round(s[1] * 0.7)]),
        };
        map.setLayoutProperty(layer.id, 'text-size', scaled);
      }
    }

    map.setPaintProperty(layer.id, 'text-color', 'rgba(60, 60, 60, 0.7)');
    map.setPaintProperty(layer.id, 'text-halo-color', 'rgba(255, 255, 255, 0.5)');
    map.setPaintProperty(layer.id, 'text-halo-width', 1);
  }
}

export function MapView() {
  const { provider } = useBasemap();
  const { category, categories, isLoading: categoriesLoading, selectCategory } =
    usePoiCategory();
  const { user, loading, updatePreferences } = useAuth();
  const key = usePremiumKey(provider.id);
  const style = provider.getStyle({ apiKey: key ?? undefined });

  const initialViewState = useMemo(() => {
    const prefs = user?.preferences;
    const hasPrefs = prefs?.lastCenter != null && prefs?.lastZoom != null;
    return {
      longitude: hasPrefs ? prefs.lastCenter![0] : DEFAULT_CENTER[0],
      latitude: hasPrefs ? prefs.lastCenter![1] : DEFAULT_CENTER[1],
      zoom: hasPrefs ? prefs.lastZoom! : DEFAULT_ZOOM,
    };
  }, [user?.preferences]);

  const mapRef = useRef<MapRef>(null);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [zoom, setZoom] = useState(initialViewState.zoom);
  const [cursor, setCursor] = useState(MAP_DEFAULT_CURSOR);

  const { selectedPoi, isLoadingPoi, selectPoi, clearSelection } = usePoiSelection(mapRef);

  const [pendingViewport, setPendingViewport] = useState<{
    center: [number, number];
    zoom: number;
  } | null>(null);

  const debouncedViewport = useDebouncedValue(pendingViewport, 2000);

  useEffect(() => {
    if (!debouncedViewport) return;
    updatePreferences({
      lastCenter: debouncedViewport.center,
      lastZoom: debouncedViewport.zoom,
    });
  }, [debouncedViewport, updatePreferences]);

  const updateViewport = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    setZoom(Math.round(map.getZoom()));

    const center = map.getCenter();
    setPendingViewport({
      center: [center.lng, center.lat],
      zoom: map.getZoom(),
    });
  }, []);

  const handleMapLoad = useCallback(() => {
    updateViewport();
    const map = mapRef.current?.getMap();
    if (!map) return;

    map.touchZoomRotate.disableRotation();

    if (!collapseAttribution(map)) {
      const onData = () => {
        if (collapseAttribution(map)) {
          map.off('sourcedata', onData);
          map.off('styledata', onData);
        }
      };
      map.on('sourcedata', onData);
      map.on('styledata', onData);
    }

    if (provider.kind === 'vector') {
      softenLabels(map);
    }
  }, [updateViewport, provider.kind]);

  const handleMouseMove = useCallback((e: MapLayerMouseEvent) => {
    setCursor(e.features?.length ? 'pointer' : MAP_DEFAULT_CURSOR);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setCursor(MAP_DEFAULT_CURSOR);
  }, []);

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const map = mapRef.current?.getMap();
      if (!map || !e.features?.length) return;

      const feature = e.features[0];
      if (!feature) return;

      if (feature.properties?.cluster_id != null) {
        const source = map.getSource('pois');
        if (source && 'getClusterExpansionZoom' in source) {
          (source as GeoJSONSource).getClusterExpansionZoom(
            feature.properties.cluster_id,
          ).then((expZoom) => {
            const geom = feature.geometry;
            if (geom.type !== 'Point') return;
            map.easeTo({
              center: geom.coordinates as [number, number],
              zoom: expZoom,
            });
          });
        }
        return;
      }

      const id = feature.properties?.id;
      if (id) selectPoi(id);
    },
    [selectPoi],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center w-full h-full bg-gray-50">
        <div className="text-center">
          <div className="w-8 h-8 border-3 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="mt-3 text-sm text-gray-500">Loading map...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full">
      <Map
        ref={mapRef}
        initialViewState={initialViewState}
        maxZoom={provider.maxZoom}
        dragRotate={false}
        touchPitch={false}
        maxPitch={0}
        mapStyle={style}
        onLoad={handleMapLoad}
        onMoveEnd={updateViewport}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onDragStart={() => setCursor('grabbing')}
        onDragEnd={() => setCursor(MAP_DEFAULT_CURSOR)}
        onClick={handleClick}
        cursor={cursor}
        interactiveLayerIds={POI_INTERACTIVE_LAYERS}
        attributionControl={false}
        transformRequest={(url: string) => {
          if (
            url.includes('tile.thunderforest.com') &&
            key &&
            !url.includes('apikey=')
          ) {
            return {
              url: url + (url.includes('?') ? '&' : '?') + 'apikey=' + key,
            };
          }
          return { url };
        }}
        style={{ width: '100%', height: '100%' }}
      >
        <NavigationControl position="top-right" showCompass={false} />
        <GeolocateControl
          position="top-right"
          positionOptions={{ enableHighAccuracy: true }}
          trackUserLocation={false}
        />
        <AttributionControl compact />
        <BasemapSwitcher />
        {bbox && <PoiLayer bbox={bbox} zoom={zoom} category={category} />}
      </Map>

      <CategorySwitcher
        category={category}
        categories={categories}
        isLoading={categoriesLoading}
        onSelect={selectCategory}
      />
      <UserMenu />

      {isLoadingPoi && (
        <div className="absolute top-0 right-0 z-20 h-full w-96 max-w-full bg-white shadow-2xl border-l border-gray-200 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {selectedPoi && !isLoadingPoi && (
        <PoiDrawer poi={selectedPoi} onClose={clearSelection} />
      )}
    </div>
  );
}
