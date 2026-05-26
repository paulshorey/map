"use client";

import { Source, Layer } from "react-map-gl/maplibre";
import { useQuery } from "@tanstack/react-query";
import { apiUrl } from "@/lib/config";
import { useDebouncedValue } from "../lib/useDebouncedValue";

const POI_CLUSTER_COLOR = "#f4b644";
const POI_SINGLE_COLOR = "#f7a917";
// const POI_SINGLE_COLOR = "#ffa500";

export type Bbox = [number, number, number, number];

interface Props {
  bbox: Bbox;
  zoom: number;
  category: string | null;
}

export function PoiLayer({ bbox, zoom, category }: Props) {
  const debounced = useDebouncedValue(bbox, 250);

  const { data } = useQuery({
    queryKey: ["pois", debounced, zoom, category],
    queryFn: async () => {
      const [w, s, e, n] = debounced;
      const params = new URLSearchParams({
        bbox: `${w},${s},${e},${n}`,
        zoom: String(zoom),
      });
      if (category) params.set("category", category);
      const r = await fetch(apiUrl(`/api/pois?${params}`));
      if (!r.ok) throw new Error("POI fetch failed");
      return r.json() as Promise<GeoJSON.FeatureCollection>;
    },
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  return (
    <Source
      id="pois"
      type="geojson"
      data={data ?? { type: "FeatureCollection", features: [] }}
      cluster
      clusterRadius={50}
      clusterMaxZoom={14}
      promoteId="id"
    >
      <Layer
        id="clusters"
        type="circle"
        filter={["has", "point_count"]}
        paint={{
          "circle-color": POI_CLUSTER_COLOR,
          "circle-radius": [
            "step",
            ["get", "point_count"],
            16,
            50,
            22,
            200,
            28,
          ],
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
          "circle-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            0.85,
          ],
        }}
      />
      <Layer
        id="cluster-count"
        type="symbol"
        filter={["has", "point_count"]}
        layout={{
          "text-field": "{point_count_abbreviated}",
          "text-size": 10,
        }}
      />
      <Layer
        id="poi-points"
        type="circle"
        filter={["!", ["has", "point_count"]]}
        paint={{
          "circle-color": POI_SINGLE_COLOR,
          "circle-radius": 7,
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
          "circle-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            0.85,
          ],
        }}
      />
    </Source>
  );
}
