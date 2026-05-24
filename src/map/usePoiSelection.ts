import { useState, useCallback, useEffect, type RefObject } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MapRef } from 'react-map-gl/maplibre';

interface PoiDetail {
  id: string;
  name: string;
  category: string;
  description?: string;
  photo_url?: string;
  geometry: GeoJSON.Point;
}

export function usePoiSelection(mapRef: RefObject<MapRef | null>) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: selectedPoi } = useQuery({
    queryKey: ['poi-detail', selectedId],
    queryFn: async () => {
      const r = await fetch(`/api/pois/${selectedId}`);
      if (!r.ok) throw new Error('POI detail fetch failed');
      return r.json() as Promise<PoiDetail>;
    },
    enabled: !!selectedId,
    staleTime: 60_000,
  });

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !selectedId) return;

    map.setFeatureState(
      { source: 'pois', id: selectedId },
      { selected: true },
    );

    return () => {
      try {
        map.removeFeatureState({ source: 'pois', id: selectedId });
      } catch {
        // source may not exist yet
      }
    };
  }, [mapRef, selectedId]);

  const selectPoi = useCallback((id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
  }, []);

  return {
    selectedId,
    selectedPoi: selectedPoi ?? null,
    selectPoi,
    clearSelection,
  };
}
