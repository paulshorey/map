"use client";

import { Source, Layer } from "react-map-gl/maplibre";

const POI_CLUSTER_COLOR = "#f7a917";
// const POI_CLUSTER_COLOR = "#f4b644";
const POI_SINGLE_COLOR = "#f7a917";
// const POI_SINGLE_COLOR = "#ffa500";

export type { Bbox } from "./usePoiList";

interface Props {
  data: GeoJSON.FeatureCollection | undefined;
}

/** Clustered marker layers; MapView owns the POI query so it can also report totals. */
export function PoiLayer({ data }: Props) {
  return (
    <Source
      id="pois"
      type="geojson"
      data={data ?? { type: "FeatureCollection", features: [] }}
      cluster
      clusterRadius={20}
      clusterMaxZoom={10}
      clusterMinPoints={3}
      promoteId="marker_id"
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
            10,
            10,
            13,
            100,
            16,
            1000,
            19,
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
            0.95,
          ],
        }}
      />
    </Source>
  );
}
