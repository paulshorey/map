"use client";

import { Source, Layer } from "react-map-gl/maplibre";
import type { ExpressionSpecification } from "maplibre-gl";

const POI_CLUSTER_COLOR = "#f7a917";
// const POI_CLUSTER_COLOR = "#f4b644";
const POI_SINGLE_COLOR = "#f7a917";
// const POI_SINGLE_COLOR = "#ffa500";

export type { Bbox } from "./usePoiList";

/** A POI flagged general, or a marker that is coarser than a point. */
const IS_GENERAL: ExpressionSpecification = [
  "any",
  ["==", ["get", "location_specificity"], "general"],
  ["!=", ["coalesce", ["get", "location_precision"], "point"], "point"],
];

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
          // General (country/region/city) locations are hollow: the point is only approximate.
          "circle-color": ["case", IS_GENERAL, "#fff", POI_SINGLE_COLOR],
          "circle-radius": ["case", [">", ["get", "stack_count"], 1], 9, 7],
          "circle-stroke-width": ["case", IS_GENERAL, 2.5, 1],
          "circle-stroke-color": ["case", IS_GENERAL, POI_SINGLE_COLOR, "#fff"],
          "circle-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            1,
            0.95,
          ],
        }}
      />
      <Layer
        id="poi-stack-count"
        type="symbol"
        filter={[
          "all",
          ["!", ["has", "point_count"]],
          [">", ["get", "stack_count"], 1],
        ]}
        layout={{
          "text-field": ["to-string", ["get", "stack_count"]],
          "text-size": 9,
          "text-allow-overlap": true,
        }}
      />
    </Source>
  );
}
