import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import countries from "i18n-iso-countries";
import { countryToCode } from "./normalize/country.js";
import { resolveLocation, type ReverseLocation } from "./location.js";
import { canonicalLocation } from "./canonical-location.js";
import {
  parseReverseLocation,
  reverseGeocode,
  GeocodeError,
} from "./providers/locationiq.js";
const empty = { country_code: null, city: null, region: null, address: null };
const hit: ReverseLocation = {
  country_code: "US",
  city: "Austin",
  region: "Texas",
  region_code: "US-TX",
  address: "100 Test St",
  postcode: "78701",
  distance_m: 20,
  provider: "locationiq",
  attribution: "fixture",
};
test("all assigned ISO names and alpha3 values round trip; observed missing countries resolve", () => {
  for (const [a2, a3] of Object.entries(countries.getAlpha2Codes())) {
    assert.equal(countryToCode(a2.toLowerCase()), a2);
    assert.equal(countryToCode(a3), a2);
    assert.equal(countryToCode(countries.getName(a2, "en")), a2);
  }
  for (const [name, code] of Object.entries({
    Taiwan: "TW",
    Singapore: "SG",
    Cuba: "CU",
    Mali: "ML",
    Indonesia: "ID",
    Morocco: "MA",
    DRC: "CD",
    Nepal: "NP",
    Gibraltar: "GI",
  }))
    assert.equal(countryToCode(name), code);
  for (const bad of ["ZZ", "XX", "CA-ON", "London", "Bavaria", "unknown", ""])
    assert.equal(countryToCode(bad), undefined);
});
test("source address wins verbatim; coordinate lookup only fills gaps", () => {
  const r = resolveLocation(
    { ...empty, address: "Official P.O. Box 12", country_code: "USA" },
    hit,
  );
  assert.equal(r.fields.address, "Official P.O. Box 12");
  assert.equal(r.fields.country_code, "US");
  assert.equal(r.fields.region, "Texas");
  assert.equal(r.provenance.address, "source");
  assert.equal(r.provenance.region, "reverse_geocode");
});
test("conflicting country and distant lookup never contaminate source fields", () => {
  const r = resolveLocation({ ...empty, country_code: "Canada" }, hit);
  assert.equal(r.fields.country_code, "CA");
  assert.equal(r.fields.address, null);
  assert.deepEqual(r.warnings, ["coordinate_country_conflict"]);
  const distant = resolveLocation(empty, { ...hit, distance_m: 2000 });
  assert.equal(distant.fields.city, null);
  assert.deepEqual(distant.warnings, ["reverse_result_too_distant"]);
});
test("reverse result is normalized without changing input coordinates or inventing address", () => {
  const r = parseReverseLocation(
    {
      lat: "30",
      lon: "-97",
      licence: "attribution",
      address: {
        country_code: "us",
        state: "Texas",
        state_code: "TX",
        city: "Austin",
        road: "Test St",
        house_number: "12",
      },
    },
    30,
    -97,
  )!;
  assert.equal(r.country_code, "US");
  assert.equal(r.region_code, "US-TX");
  assert.equal(r.address, "12 Test St");
  assert.equal(r.distance_m, 0);
  assert.equal(
    parseReverseLocation(
      {
        lat: "30",
        lon: "-97",
        address: { country_code: "us", city: "Austin" },
      },
      30,
      -97,
    )?.address,
    null,
  );
  assert.throws(
    () => parseReverseLocation({ lat: "", lon: "-97", address: {} }, 30, -97),
    /Invalid reverse/,
  );
  assert.equal(
    parseReverseLocation({ error: "Unable to geocode" }, 30, -97),
    null,
  );
});
const fetchBefore = globalThis.fetch,
  key = process.env.LOCATIONIQ_API_KEY;
afterEach(() => {
  globalThis.fetch = fetchBefore;
  if (key === undefined) delete process.env.LOCATIONIQ_API_KEY;
  else process.env.LOCATIONIQ_API_KEY = key;
});
test("reverse transport/auth failure remains a provider failure, not a cached miss", async () => {
  process.env.LOCATIONIQ_API_KEY = "fixture";
  globalThis.fetch = async () =>
    Response.json({ error: "denied" }, { status: 401 });
  await assert.rejects(
    reverseGeocode(30, -97),
    (e: unknown) =>
      e instanceof GeocodeError && e.status === 401 && !e.retryable,
  );
});
test("canonical fields follow coordinate neighbourhood and source addresses outrank inferred ones", () => {
  const row = {
    id: "a",
    source_slug: "official",
    source_id: "s",
    source_trust: 10,
    lat: 30,
    lng: -97,
    country_code: "US",
    city: "Austin",
    region: "Texas",
    address: "Official address",
    attributes: {},
  };
  const inferred = {
    ...row,
    id: "b",
    source_trust: 100,
    address: "Nearby road",
    attributes: {
      location_enrichment: { provenance: { address: "reverse_geocode" } },
    },
  };
  const distant = {
    ...row,
    id: "c",
    lat: 40,
    country_code: "CA",
    city: "Wrong city",
    source_trust: 200,
    address: "Wrong distant address",
  };
  const r = canonicalLocation([inferred, distant, row], row);
  assert.equal(r.address.value, "Official address");
  assert.equal(r.city.value, "Austin");
  assert.equal(r.country_code.value, "US");
  assert.equal(r.address.provenance?.derivation, "source");
});

test("source state abbreviations are compared in country context and conflicts are visible", () => {
  assert.deepEqual(
    resolveLocation({ ...empty, region: "TX" }, hit).warnings,
    [],
  );
  const bad = resolveLocation({ ...empty, region: "Washington" }, hit);
  assert.ok(bad.warnings.includes("coordinate_region_conflict"));
  assert.equal(bad.fields.address, null);
  assert.equal(bad.region_code, null);
});

// Registered wrappers must not be mistaken for a one-record metadata object.
test("both new music captures resolve their explicit array wrapper", async () => {
  const { resolveSourceFile } = await import("./source-file.js");
  for (const name of [
    "data/poi/music-festivals/apis/jambase_festivals.json",
    "data/poi/music-festivals/directories/thatfestivalsite_festivals.json",
  ]) {
    const source = await resolveSourceFile(name, "music_festival");
    assert.equal(source.file.wrapperPath, "festivals");
    assert.equal(source.extractorVersion, "2");
  }
});

test("camel-case API event dates are deterministic source facts", async () => {
  const { buildDeterministicFacts } =
    await import("./normalize/deterministic.js");
  const facts = buildDeterministicFacts({
    name: "Festival",
    description: null,
    website: null,
    source_url: null,
    phone: null,
    email: null,
    address: null,
    city: "Montreal",
    region: "Quebec",
    country_code: "CA",
    lat: 45.5,
    lng: -73.5,
    attributes: {},
    raw: { startDate: "2026-06-12", endDate: "2026-06-20" },
    sourceIsPoiHint: null,
  });
  assert.equal(facts.startDate, "2026-06-12");
  assert.equal(facts.endDate, "2026-06-20");
});
