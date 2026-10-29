import { useQuery } from "@tanstack/react-query";
import type { PoiListResponse } from "@lib/db-map/contracts/map-app";
import { apiUrl } from "@/lib/config";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import type { PoiLocationFilter } from "./usePoiLocationFilter";

export type Bbox = [number, number, number, number];

/** POIs in the current viewport plus the total match count (which may exceed the marker limit). */
export function usePoiList(
  bbox: Bbox | null,
  zoom: number,
  category: string | null,
  location: PoiLocationFilter,
) {
  const debounced = useDebouncedValue(bbox, 250);

  return useQuery({
    queryKey: ["pois", debounced, zoom, category, location],
    enabled: debounced !== null,
    queryFn: async () => {
      const [w, s, e, n] = debounced!;
      const params = new URLSearchParams({
        bbox: `${w},${s},${e},${n}`,
        zoom: String(zoom),
      });
      if (category) params.set("category", category);
      if (location !== "all") params.set("location", location);
      const r = await fetch(apiUrl(`/api/pois?${params}`));
      if (!r.ok) throw new Error("POI fetch failed");
      return r.json() as Promise<PoiListResponse>;
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}
