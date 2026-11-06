import assert from "node:assert/strict";
import { test } from "node:test";
import { recordLocations, locationRole } from "./record-locations.js";
import { canonicalLocationId, groupCanonicalLocations, type MemberLocation } from "./canonical-locations.js";

test("a record keeps every location it knows: source, inferred and rejected", () => {
  const locations = recordLocations({
    source: { lat: 35.1815, lng: 136.9066, precision: "point", coordinate_source: "source" },
    inferred: { lat: 35.18, lng: 136.9, precision: "city", query: "Nagoya, JP" },
    basis: "locality",
    fallbackFrom: null,
    rejected: {
      reason: "forward_locality_conflict",
      query: "Aichi Arts Center, Nagoya, JP",
      result: { lat: 35.634, lng: 139.879, precision: "point" },
    },
  });
  assert.deepEqual(
    locations.map((l) => [l.kind, l.origin, l.role, l.precision, l.status]),
    [
      ["source", "source_coordinates", "venue", "point", "accepted"],
      ["inferred", "listed_address_geocode", "locality", "city", "accepted"],
      ["inferred", "listed_address_geocode", "venue", "point", "rejected"],
    ],
  );
  assert.equal(locations[2]!.reason, "forward_locality_conflict");
});

test("fallbacks, URL points and invalid points are classified", () => {
  const [city] = recordLocations({
    source: null,
    inferred: { lat: 18.9, lng: -99.2, precision: "city" },
    basis: "locality",
    fallbackFrom: { reason: "miss", query: "Estudio…, Cuernavaca" },
    rejected: null,
  });
  assert.equal(city!.origin, "city_fallback");
  const [country] = recordLocations({
    source: { lat: 0, lng: 0 },
    inferred: { lat: 9.6, lng: 8.0, precision: "country" },
    basis: "locality",
    fallbackFrom: { reason: "rejected", query: "East Africa" },
    rejected: null,
  });
  assert.equal(country!.origin, "country_fallback");
  assert.equal(country!.role, "country");
  const [url] = recordLocations({
    source: { lat: 45.4, lng: 12.3, coordinate_source: "url" },
    inferred: null,
    basis: null,
    fallbackFrom: null,
    rejected: null,
  });
  assert.equal(url!.origin, "url_coordinates");
  assert.equal(locationRole("point", "address"), "address");
});

test("a canonical maps the union of its members' locations, de-duplicated by point", () => {
  const m = (id: string, poi: string, source: string, lat: number, lng: number, precision = "point", role = "venue"): MemberLocation => ({
    id, research_poi_id: poi, source, kind: "source", origin: "source_coordinates", role, precision, lat, lng, label: null,
  });
  const grouped = groupCanonicalLocations(
    [
      m("a1", "a", "biennale_com", 45.4346809, 12.3509152),
      m("b1", "b", "biennial_association", 45.433, 12.3597),
      m("c1", "c", "biennial_foundation", 45.433, 12.3597),
      { ...m("c2", "c", "biennial_foundation", 45.44, 12.33, "city", "locality"), kind: "inferred" },
    ],
    { lat: 45.433, lng: 12.3597 },
  );
  assert.equal(grouped.length, 3, "two members at the same point are one location");
  assert.equal(grouped[0]!.is_primary, true);
  assert.deepEqual(grouped[0]!.sources, ["biennial_association", "biennial_foundation"]);
  assert.deepEqual(grouped[0]!.research_poi_ids, ["b", "c"]);
  assert.equal(grouped[0]!.specificity, "precise");
  assert.equal(grouped.at(-1)!.specificity, "general");
  assert.deepEqual(grouped.map((g) => g.ordinal), [0, 1, 2]);
});

test("canonical location IDs are stable per build and point", () => {
  const id = canonicalLocationId("00000000-0000-4000-8000-000000000001", 45.4375, 12.3358);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, canonicalLocationId("00000000-0000-4000-8000-000000000001", 45.43750000001, 12.3358));
  assert.notEqual(id, canonicalLocationId("00000000-0000-4000-8000-000000000002", 45.4375, 12.3358));
  assert.notEqual(id, canonicalLocationId("00000000-0000-4000-8000-000000000001", 45.4376, 12.3358));
});
