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
  attributes?: unknown;
  sources?: string[];
}

/** Clicked POI first, then every other POI whose marker shares its exact point. */
export interface PoiSelection {
  location: PoiLocationRecord | null;
  pois: PoiDetail[];
  total: number;
  truncated: boolean;
}

interface Selected {
  id: string;
  kind: string | null;
}

export function usePoiSelection(mapRef: RefObject<MapRef | null>) {
  const [selected, setSelected] = useState<Selected | null>(null);
  const selectedId = selected?.id ?? null;

  const { data: selection, isLoading } = useQuery({
    queryKey: ["poi-colocated", selected?.id, selected?.kind],
    queryFn: async () => {
      const kind = selected?.kind
        ? `?kind=${encodeURIComponent(selected.kind)}`
        : "";
      const r = await fetch(
        apiUrl(`/api/pois/${selected!.id}/colocated${kind}`),
      );
      if (!r.ok) throw new Error("POI detail fetch failed");
      return r.json() as Promise<PoiSelection>;
    },
    enabled: !!selected,
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

  const selectPoi = useCallback((id: string, kind?: string | null) => {
    // Either marker opens the shared record; the clicked marker's point decides co-location.
    setSelected({ id, kind: kind ?? null });
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
