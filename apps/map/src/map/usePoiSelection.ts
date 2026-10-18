import { useState, useCallback, useEffect, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MapRef } from "react-map-gl/maplibre";
import { apiUrl } from "@/lib/config";
import type {
  PoiLocationRecord,
  PoiCoordinateEvidenceRecord,
} from "@lib/db-map/contracts/map-app";

export interface PoiDetail {
  id: string;
  name: string;
  category: string;
  description?: string;
  address?: string;
  website?: string;
  hours?: string;
  photo_url?: string;
  starts_at?: string | null;
  ends_at?: string | null;
  date_precision?: string | null;
  status?: string | null;
  lat?: number;
  lng?: number;
  geometry: GeoJSON.Point;
  locations?: PoiLocationRecord[];
  coordinate_evidence?: PoiCoordinateEvidenceRecord;
}

export function usePoiSelection(mapRef: RefObject<MapRef | null>) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: selectedPoi, isLoading } = useQuery({
    queryKey: ["poi-detail", selectedId],
    queryFn: async () => {
      const r = await fetch(apiUrl(`/api/pois/${selectedId}`));
      if (!r.ok) throw new Error("POI detail fetch failed");
      return r.json() as Promise<PoiDetail>;
    },
    enabled: !!selectedId,
    staleTime: 60_000,
  });

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !selectedId) return;

    try {
      for (const slot of ["source", "inferred", "legacy"])
        map.setFeatureState(
          { source: "pois", id: `${selectedId}:${slot}` },
          { selected: true },
        );
    } catch {
      // source may not exist yet
    }

    return () => {
      try {
        for (const slot of ["source", "inferred", "legacy"])
          map.removeFeatureState({
            source: "pois",
            id: `${selectedId}:${slot}`,
          });
      } catch {
        // source may have been removed
      }
    };
  }, [mapRef, selectedId]);

  const selectPoi = useCallback((id: string) => {
    // Either marker opens the shared record, including when its other marker is selected.
    setSelectedId(id);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedId(null);
  }, []);

  return {
    selectedId,
    selectedPoi: selectedPoi ?? null,
    isLoadingPoi: isLoading && !!selectedId,
    selectPoi,
    clearSelection,
  };
}
