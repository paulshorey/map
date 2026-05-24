import {
  Map,
  NavigationControl,
  GeolocateControl,
  AttributionControl,
  type MapRef,
  type MapLayerMouseEvent,
} from 'react-map-gl/maplibre';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useRef, useCallback, useState } from 'react';
import { useBasemap } from '../basemap/useBasemap';
import { usePremiumKey } from '../auth/usePremiumKey';
import { BasemapSwitcher } from '../basemap/BasemapSwitcher';
import { PoiLayer, type Bbox } from './PoiLayer';
import { PoiDrawer } from './PoiDrawer';
import { usePoiSelection } from './usePoiSelection';

export function MapView() {
  const { provider } = useBasemap();
  const key = usePremiumKey(provider.id);
  const style = provider.getStyle({ apiKey: key ?? undefined });

  const mapRef = useRef<MapRef>(null);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const [zoom, setZoom] = useState(4);

  const { selectedPoi, selectPoi, clearSelection } = usePoiSelection(mapRef);

  const updateViewport = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const b = map.getBounds();
    setBbox([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    setZoom(Math.round(map.getZoom()));
  }, []);

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      const map = mapRef.current?.getMap();
      if (!map || !e.features?.length) return;

      const feature = e.features[0];

      if (feature.properties?.cluster_id != null) {
        const source = map.getSource('pois');
        if (source && 'getClusterExpansionZoom' in source) {
          (source as maplibregl.GeoJSONSource).getClusterExpansionZoom(
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

  return (
    <div className="relative w-full h-full">
      <Map
        ref={mapRef}
        initialViewState={{ longitude: -98.5, latitude: 39.8, zoom: 4 }}
        maxZoom={provider.maxZoom}
        mapStyle={style}
        onLoad={updateViewport}
        onMoveEnd={updateViewport}
        onClick={handleClick}
        interactiveLayerIds={['clusters', 'poi-points']}
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
        <NavigationControl position="top-right" />
        <GeolocateControl
          position="top-right"
          positionOptions={{ enableHighAccuracy: true }}
          trackUserLocation={false}
        />
        <AttributionControl compact />
        <BasemapSwitcher />
        {bbox && <PoiLayer bbox={bbox} zoom={zoom} />}
      </Map>

      {selectedPoi && (
        <PoiDrawer poi={selectedPoi} onClose={clearSelection} />
      )}
    </div>
  );
}
