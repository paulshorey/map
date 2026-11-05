import { useState, useCallback, useEffect, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import type { MapRef } from "react-map-gl/maplibre";
import { apiUrl } from "@/lib/config";
import type {
  PoiMapLocationRecord,
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
  locations?: PoiMapLocationRecord[];
  coordinate_evidence?: PoiCoordinateEvidenceRecord;
  attributes?: unknown;
  sources?: string[];
}

/** Clicked POI first, then every other POI whose marker shares its exact point. */
export interface PoiSelection {
  location: PoiMapLocationRecord | null;
  pois: PoiDetail[];
  total: number;
  truncated: boolean;
}

interface Selected {
  id: string;
  location: string | null;
}

export function usePoiSelection(mapRef: RefObject<MapRef | null>) {
  const [selected, setSelected] = useState<Selected | null>(null);
  const selectedId = selected?.id ?? null;

  const { data: selection, isLoading } = useQuery({
    queryKey: ["poi-colocated", selected?.id, selected?.location],
    queryFn: async () => {
      const location = selected?.location
        ? `?location=${encodeURIComponent(selected.location)}`
        : "";
      const r = await fetch(
        apiUrl(`/api/pois/${selected!.id}/colocated${location}`),
      );
      if (!r.ok) throw new Error("POI detail fetch failed");
      return r.json() as Promise<PoiSelection>;
    },
    enabled: !!selected,
    staleTime: 60_000,
  });

  // Highlight every marker of the selected POI (one per known location).
  const markerIds = (
    selection?.pois.find((poi) => poi.id === selectedId)?.locations ?? []
  ).map((location) => `${selectedId}:${location.id}`);
  const markerKey = markerIds.join("|");
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !markerKey) return;
    const ids = markerKey.split("|");
    try {
      for (const id of ids)
        map.setFeatureState({ source: "pois", id }, { selected: true });
    } catch {
      // source may not exist yet
    }
    return () => {
      try {
        for (const id of ids) map.removeFeatureState({ source: "pois", id });
      } catch {
        // source may have been removed
      }
    };
  }, [mapRef, markerKey]);

  const selectPoi = useCallback((id: string, location?: string | null) => {
    // Any marker opens the shared record; the clicked location decides co-location.
    setSelected({ id, location: location ?? null });
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(null);
  }, []);

  return {
    selectedId,
    selection: selection ?? null,
    isLoadingPoi: isLoading && !!selected,
    selectPoi,
    clearSelection,
  };
}
