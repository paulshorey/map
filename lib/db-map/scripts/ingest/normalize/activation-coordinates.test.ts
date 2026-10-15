import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activationCoordinates,
  type CoordinateProjection,
} from "./activation-coordinates.js";
import { fixCoordinates } from "./geo.js";

const row: CoordinateProjection = {
  active_normalization_id: "current",
  active_geocode_id: null,
  geocode_normalization_id: null,
  projected_lat: 0,
  projected_lng: 0,
  coordinate_source: null,
  coordinate_precision: null,
};
const missing = {
  lat: null,
  lng: null,
  coordinateSource: null,
  coordinatePrecision: null,
};

test("invalid source coordinates are cleared instead of retaining the extracted zero pair", () => {
  const result = activationCoordinates(row, "current", missing);
  assert.equal(result.lat, null);
  assert.equal(result.lng, null);
  assert.equal(result.changed, true);
  assert.equal(result.keepGeocode, false);
});

test("validated swaps and coordinates extracted from URLs replace the raw projection", () => {
  const fixed = fixCoordinates(-110, 38);
  const result = activationCoordinates(
    { ...row, projected_lat: -110, projected_lng: 38 },
    "new",
    {
      ...fixed,
      coordinateSource: "source",
      coordinatePrecision: "point",
    },
  );
  assert.deepEqual([result.lat, result.lng], [38, -110]);
  assert.equal(result.changed, true);
  assert.equal(
    activationCoordinates(row, "new", {
      lat: 38,
      lng: -110,
      coordinateSource: "url",
      coordinatePrecision: "point",
    }).source,
    "url",
  );
});

test("a valid geocode survives only for its exact unchanged normalization artifact", () => {
  const geocoded = {
    ...row,
    projected_lat: 38,
    projected_lng: -110,
    coordinate_source: "geocode",
    coordinate_precision: "point",
    active_geocode_id: "geo",
    geocode_normalization_id: "current",
  };
  assert.equal(
    activationCoordinates(geocoded, "current", missing).keepGeocode,
    true,
  );
  assert.equal(
    activationCoordinates(geocoded, "current", missing).changed,
    false,
  );
  assert.equal(activationCoordinates(geocoded, "new", missing).lat, null);
  assert.equal(
    activationCoordinates(
      { ...geocoded, geocode_normalization_id: "other" },
      "current",
      missing,
    ).lat,
    null,
  );
  assert.equal(
    activationCoordinates(
      { ...geocoded, projected_lat: 0, projected_lng: 0 },
      "current",
      missing,
    ).keepGeocode,
    false,
  );
  const dangling = activationCoordinates(
    { ...geocoded, projected_lat: null, projected_lng: null },
    "current",
    missing,
  );
  assert.equal(dangling.changed, false);
  assert.equal(dangling.needsActivation, true);
});

test("valid source coordinates remain reusable without changing their point", () => {
  const result = activationCoordinates(
    { ...row, projected_lat: 38, projected_lng: -110 },
    "current",
    {
      lat: 38,
      lng: -110,
      coordinateSource: "source",
      coordinatePrecision: "point",
    },
  );
  assert.equal(result.changed, false);
  assert.equal(result.source, "source");
});

test("a location enrichment artifact stays bound to an unchanged source point", () => {
  const source = {
    ...row,
    projected_lat: 38,
    projected_lng: -110,
    coordinate_source: "source",
    active_geocode_id: "location",
    geocode_normalization_id: "current",
  };
  const facts = {
    lat: 38,
    lng: -110,
    coordinateSource: "source" as const,
    coordinatePrecision: "point" as const,
  };
  assert.equal(
    activationCoordinates(source, "current", facts).keepGeocode,
    true,
  );
  assert.equal(
    activationCoordinates(source, "current", { ...facts, lat: 39 }).keepGeocode,
    false,
  );
  assert.equal(activationCoordinates(source, "new", facts).keepGeocode, false);
});
