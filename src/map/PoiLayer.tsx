'use client';

import { Source, Layer } from 'react-map-gl/maplibre';
import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '@/lib/config';
import { useDebouncedValue } from '../lib/useDebouncedValue';

export type Bbox = [number, number, number, number];

interface Props {
  bbox: Bbox;
  zoom: number;
}

export function PoiLayer({ bbox, zoom }: Props) {
  const debounced = useDebouncedValue(bbox, 250);

  const { data } = useQuery({
    queryKey: ['pois', debounced, zoom],
    queryFn: async () => {
      const [w, s, e, n] = debounced;
      const r = await fetch(
        apiUrl(`/api/pois?bbox=${w},${s},${e},${n}&zoom=${zoom}`),
      );
      if (!r.ok) throw new Error('POI fetch failed');
      return r.json() as Promise<GeoJSON.FeatureCollection>;
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  return (
    <Source
      id="pois"
      type="geojson"
      data={data ?? { type: 'FeatureCollection', features: [] }}
      cluster
      clusterRadius={50}
      clusterMaxZoom={14}
      promoteId="id"
    >
      <Layer
        id="clusters"
        type="circle"
        filter={['has', 'point_count']}
        paint={{
          'circle-color': [
            'step',
            ['get', 'point_count'],
            '#51bbd6',
            50,
            '#f1f075',
            200,
            '#f28cb1',
          ],
          'circle-radius': [
            'step',
            ['get', 'point_count'],
            16,
            50,
            22,
            200,
            28,
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
        }}
      />
      <Layer
        id="cluster-count"
        type="symbol"
        filter={['has', 'point_count']}
        layout={{
          'text-field': '{point_count_abbreviated}',
          'text-size': 12,
        }}
      />
      <Layer
        id="poi-points"
        type="circle"
        filter={['!', ['has', 'point_count']]}
        paint={{
          'circle-color': '#1f6feb',
          'circle-radius': 7,
          'circle-stroke-width': 2,
          'circle-stroke-color': '#fff',
          'circle-opacity': [
            'case',
            ['boolean', ['feature-state', 'selected'], false],
            1,
            0.85,
          ],
        }}
      />
    </Source>
  );
}
