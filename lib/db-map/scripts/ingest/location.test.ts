import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import countries from "i18n-iso-countries";
import { countryToCode } from "./normalize/country.js";
import {
  capLocalityPrecision,
  localityValue,
  forwardImplausible,
  providerNameAgrees,
  resolveLocation,
  reverseForPrecision,
  type ReverseLocation,
} from "./location.js";
import { canonicalLocation } from "./canonical-location.js";
import { suppliedCountryCentroid } from "./supplied-centroids.js";
import { geocode, GeocodeError } from "./providers/locationiq.js";
import { buildGazetteer, offlineReverse } from "./offline-reverse.js";
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
// GeoNames columns: id, name, asciiname, alternates, lat, lng, class, code, country, cc2, admin1.
const place = (name: string, lat: number, lng: number, cc: string, a1: string) =>
  ["1", name, name, "", lat, lng, "P", "PPL", cc, "", a1, "", "", "", "5000"].join("\t");
// A square boundary in thousandths of a degree: [west, south, east, north].
const square = (w: number, s: number, e: number, n: number) =>
  [w, s, e, s, e, n, w, n, w, s].map((v) => Math.round(v * 1000));
const gazetteer = buildGazetteer(
  [
    place("West Yellowstone", 44.66, -111.1, "US", "MT"),
    place("Gardiner", 45.03, -110.7, "US", "MT"),
    place("Austin", 30.27, -97.74, "US", "TX"),
    place("Basel", 47.56, 7.59, "CH", "BS"),
    place("Saint-Louis", 47.59, 7.56, "FR", "44"),
    place("Taveuni", -16.85, -179.97, "FJ", "03"),
    place("Key West", 24.56, -81.78, "US", "FL"),
  ].join("\n"),
  ["US.FL\tFlorida\tFlorida\t1", "FJ.03\tNorthern\tNorthern\t2"].join("\n"),
  {
    scale: 1000,
    units: [
      { c: "US", r: "Wyoming", rc: "US-WY", p: [[square(-111.05, 41, -104.05, 45)]] },
      { c: "US", r: "Montana", rc: "US-MT", p: [[square(-116, 45, -104.05, 49)], [square(-116, 44.4, -111.05, 45)]] },
      // A hole: the enclave is not part of the surrounding unit.
      { c: "US", r: "Texas", rc: "US-TX", p: [[square(-100, 29, -96, 32), square(-99, 31, -98.5, 31.5)]] },
      { c: "CH", r: "Basel-City", rc: "CH-BS", p: [[square(7.57, 47.5, 7.7, 47.585)]] },
      { c: "FR", r: "Grand Est", rc: null, p: [[square(7.4, 47.585, 7.7, 47.7)]] },
      { c: null, r: null, rc: null, p: [[square(10, 10, 11, 11)]] },
    ],
  },
);
test("offline reverse reads country and region from the containing boundary", () => {
  // Old Faithful: every nearby town is in Montana, the point is in Wyoming.
  const r = offlineReverse(44.4605, -110.8281, gazetteer)!;
  assert.equal(r.country_code, "US");
  assert.equal(r.region, "Wyoming");
  assert.equal(r.region_code, "US-WY");
  assert.equal(r.city, null, "no town within 15 km");
  assert.equal(r.address, null);
  assert.equal(r.postcode, null);
  assert.equal(r.basis, "containing_area");
  assert.equal(r.provider, "geonames");
  // A town centre a few kilometres away is still usable: this is an area lookup.
  const austin = resolveLocation(empty, offlineReverse(30.3, -97.8, gazetteer));
  assert.equal(austin.fields.city, "Austin");
  assert.equal(austin.fields.region, "Texas");
  assert.deepEqual(austin.warnings, []);
  // Inside a hole of the Texas boundary, no boundary contains the point.
  assert.equal(offlineReverse(31.25, -98.75, gazetteer), null);
});
test("offline reverse never names a town across a border", () => {
  const basel = offlineReverse(47.57, 7.58, gazetteer)!;
  assert.equal(basel.country_code, "CH");
  assert.equal(basel.city, "Basel");
  // Just inside France, 2 km from Basel's centre: the French town, not Basel.
  const france = offlineReverse(47.586, 7.58, gazetteer)!;
  assert.equal(france.country_code, "FR");
  assert.equal(france.city, "Saint-Louis");
  assert.equal(france.region_code, null);
});
test("outside every boundary, nearby places name the area only when they agree", () => {
  const key = offlineReverse(24.55, -81.8, gazetteer)!;
  assert.equal(key.basis, "nearby_places");
  assert.equal(key.country_code, "US");
  assert.equal(key.region, "Florida");
  assert.equal(key.region_code, "US-FL");
  assert.equal(key.city, "Key West");
  // Across the antimeridian.
  assert.equal(offlineReverse(-16.85, 179.99, gazetteer)?.city, "Taveuni");
  // Open ocean: nothing names the area.
  assert.equal(offlineReverse(0.5, -30, gazetteer), null);
  // A disputed unit carries no country.
  assert.equal(offlineReverse(10.5, 10.5, gazetteer), null);
  assert.throws(() => offlineReverse(91, 0, gazetteer), /Invalid reverse/);
});
test("the vendored data answers real points", () => {
  const cases: Array<[number, number, string, string | null, string | null]> = [
    [30.2672, -97.7431, "US", "Texas", "Austin"],
    [44.4605, -110.8281, "US", "Wyoming", null], // Old Faithful
    [48.8566, 2.3522, "FR", "Île-de-France", "Paris"],
    [51.5074, -0.1278, "GB", "England", "London"],
    [45.4343, 12.3388, "IT", "Veneto", "Venice"],
    [-33.8688, 151.2093, "AU", "New South Wales", "Sydney"],
    [35.1815, 136.9066, "JP", "Aichi", "Nagoya"],
    [48.985, -123.07, "US", "Washington", "Point Roberts"], // an exclave below Canada
  ];
  for (const [lat, lng, country, region, city] of cases) {
    const r = offlineReverse(lat, lng)!;
    assert.deepEqual([r.country_code, r.region, r.city], [country, region, city], `${lat},${lng}`);
  }
});
const fetchBefore = globalThis.fetch,
  key = process.env.LOCATIONIQ_API_KEY;
afterEach(() => {
  globalThis.fetch = fetchBefore;
  if (key === undefined) delete process.env.LOCATIONIQ_API_KEY;
  else process.env.LOCATIONIQ_API_KEY = key;
});
test("forward transport/auth failure remains a provider failure, not a cached miss", async () => {
  process.env.LOCATIONIQ_API_KEY = "fixture";
  globalThis.fetch = async () =>
    Response.json({ error: "denied" }, { status: 401 });
  await assert.rejects(
    geocode("Austin, Texas"),
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
    assert.equal(
      source.extractorVersion,
      name.includes("thatfestivalsite") ? "4" : "2",
    );
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

test("a coarse point's reverse lookup never invents finer locality", () => {
  // AFiRIperFOMA: Nigeria's centroid reverse-geocodes to a Kaduna village.
  const country = resolveLocation(
    { ...empty, country_code: "NG" },
    reverseForPrecision(
      { ...hit, country_code: "NG", city: "Kurmin Musa", region: "Kaduna", region_code: null },
      "country",
    ),
  );
  assert.deepEqual(country.fields, { ...empty, country_code: "NG" });
  const region = reverseForPrecision(hit, "region")!;
  assert.equal(region.city, null);
  assert.equal(region.region, "Texas");
  assert.equal(region.address, null);
  const city = reverseForPrecision(hit, "city")!;
  assert.equal(city.city, "Austin");
  assert.equal(city.address, null);
  assert.equal(city.postcode, null);
  assert.equal(reverseForPrecision(hit, "point"), hit);
  // Unknown precision is coarse: no street address or postcode, locality kept.
  const unknown = reverseForPrecision(hit, null)!;
  assert.equal(unknown.address, null);
  assert.equal(unknown.postcode, null);
  assert.equal(unknown.city, "Austin");
  assert.equal(reverseForPrecision(null, "country"), null);
});

test("a supplied point repeating a published country centroid is country precision", () => {
  // Biennial Foundation's Adelaide record supplies Australia's centroid, rounded.
  assert.equal(suppliedCountryCentroid({ lat: -25.2744, lng: 133.7751 }), "AU");
  assert.equal(suppliedCountryCentroid({ lat: -25.2744, lng: 133.7751 }, "AU"), "AU");
  assert.equal(suppliedCountryCentroid({ lat: 9.081999, lng: 8.675277 }), "NG");
  assert.equal(suppliedCountryCentroid({ lat: -25.27, lng: 133.78 }), "AU");
  // A listed country other than the centroid's rules it out.
  assert.equal(suppliedCountryCentroid({ lat: -25.2744, lng: 133.7751 }, "NZ"), null);
  // Real venues near microstate centroids, written to full precision, stay points:
  // St. Peter's Basilica (Vatican centroid 41.902916, 12.453389) and a Singapore venue
  // about 300 m from Singapore's centroid (1.352083, 103.819836).
  assert.equal(suppliedCountryCentroid({ lat: 41.902168, lng: 12.453937 }, "VA"), null);
  assert.equal(suppliedCountryCentroid({ lat: 1.3545, lng: 103.8212 }, "SG"), null);
  // A Rome venue 3.4 km from the Vatican centroid, and Aichi's Nagoya venue.
  assert.equal(suppliedCountryCentroid({ lat: 41.9334, lng: 12.4534 }), null);
  assert.equal(suppliedCountryCentroid({ lat: 35.1815, lng: 136.9066 }), null);
  // Two decimals: only the rounded (1.35, 103.82) or truncated (1.35, 103.81) cells match
  // Singapore's 1.352083, 103.819836; the neighbouring cell 1.36, 103.82 does not.
  assert.equal(suppliedCountryCentroid({ lat: 1.35, lng: 103.82 }), "SG");
  assert.equal(suppliedCountryCentroid({ lat: 1.35, lng: 103.81 }), "SG");
  assert.equal(suppliedCountryCentroid({ lat: 1.36, lng: 103.82 }), null);
  // Negative halfway ties: Mayotte's -12.8275 formats to -12.828 (and Math.round gives -12.827).
  assert.equal(suppliedCountryCentroid({ lat: -12.828, lng: 45.166 }), "YT");
  assert.equal(suppliedCountryCentroid({ lat: -12.827, lng: 45.166 }), "YT");
  assert.equal(suppliedCountryCentroid({ lat: -12.829, lng: 45.166 }), null);
  assert.equal(suppliedCountryCentroid({ lat: -25.2745, lng: 133.7751 }), null);
  // One decimal cannot tell a copied centroid from a coarse point.
  assert.equal(suppliedCountryCentroid({ lat: -25.3, lng: 133.8 }), null);
  assert.equal(suppliedCountryCentroid({ lat: null, lng: null }), null);
});

test("region/country-only lookups never yield a venue; name lookups must name the place", () => {
  const shop = { precision: "point", raw_response: { class: "amenity", address: { name: "East Africa" } } };
  // "East Africa" (no listed city) returned a Göteborg restaurant.
  assert.equal(forwardImplausible("locality", { city: null, name: "East Africa Art Biennale" }, shop), "locality_result_too_specific");
  assert.equal(forwardImplausible("locality", { city: "Various", name: "x" }, { precision: "city" }), "locality_result_too_specific");
  assert.equal(forwardImplausible("locality", { city: null }, { precision: "region" }), null);
  assert.equal(forwardImplausible("locality", { city: null }, { precision: "country" }), null);
  // With a listed city, a city/point result is the existing city path.
  assert.equal(forwardImplausible("locality", { city: "Nagoya" }, { precision: "city" }), null);
  // Name lookups: "Ray-Ban" for RAY Fotografieprojekte, bare "Biennale" for Online Biennale.
  const named = (name: string) => ({ precision: "point", raw_response: { address: { name } } });
  assert.equal(forwardImplausible("name", { name: "RAY Fotografieprojekte Frankfurt/RheinMain" }, named("Ray-Ban")), "name_result_mismatch");
  assert.equal(forwardImplausible("name", { name: "Online Biennale" }, named("Biennale")), "name_result_mismatch");
  assert.equal(forwardImplausible("name", { name: "Dhaka Art Summit" }, { precision: "point", raw_response: {} }), "name_result_mismatch");
  // Conservative: a provider name with a distinctive word the listing lacks is not trusted.
  assert.equal(forwardImplausible("name", { name: "Zeitz MOCAA" }, named("Zeitz Museum of Contemporary Art Africa")), "name_result_mismatch");
  assert.equal(forwardImplausible("name", { name: "Museo Tamayo Arte Contemporáneo" }, named("Museo Tamayo")), null);
  // A coarse name-only result needs listed locality: with none it may be a shared word only.
  assert.equal(forwardImplausible("name", { name: "Helsinki Biennial" }, { precision: "city" }), "name_result_mismatch");
  assert.equal(forwardImplausible("name", { name: "Georgia Botanical Garden" }, { precision: "region" }), "name_result_mismatch");
  assert.equal(forwardImplausible("name", { name: "Helsinki Biennial", country_code: "FI" }, { precision: "city" }), null);
  assert.equal(forwardImplausible("venue", { name: "x" }, shop), null);
  assert.equal(providerNameAgrees("Les Ateliers de Rennes", "Ateliers"), true);
});

test("a locality-only lookup never yields a point", () => {
  const business = {
    precision: "point",
    precision_evidence: { value: "point", derivation: "fallback", warnings: ["point_precision_default"] },
  };
  const capped = capLocalityPrecision("locality", business);
  assert.equal(capped.precision, "city");
  assert.equal(capped.precision_evidence.derivation, "locality_query_cap");
  assert.ok(capped.precision_evidence.warnings.includes("locality_query_point_capped"));
  assert.equal(capLocalityPrecision("venue", business), business);
  assert.equal(capLocalityPrecision("locality", { precision: "country" }).precision, "country");
});

test("a provider name stored under its category key is read", () => {
  const museum = { precision: "point", raw_response: { address: { tourism: "Museo Tamayo", city: "Mexico City" } } };
  assert.equal(forwardImplausible("name", { name: "Museo Tamayo Arte Contemporáneo" }, museum), null);
  const shop = { precision: "point", raw_response: { address: { shop: "Ray-Ban", city: "Frankfurt" } } };
  assert.equal(forwardImplausible("name", { name: "RAY Fotografieprojekte" }, shop), "name_result_mismatch");
});

test("qualified Various placeholders and non-ISO centroid codes never project", () => {
  for (const filler of ["Various villages", "Various (England)", "Various (nationwide)", "TBA (online)", "Multiple towns"])
    assert.equal(localityValue(filler), null, filler);
  for (const place of ["Many", "Variousville", "Online Park Road"]) assert.equal(localityValue(place), place);
  // Gaza's vendored centroid code GZ is not ISO; it identifies precision, never a country code.
  assert.equal(suppliedCountryCentroid({ lat: 31.354676, lng: 34.308825 }), "GZ");
  assert.equal(countryToCode("GZ"), undefined);
});

test("short acronyms and non-Latin names still count as distinctive", () => {
  assert.equal(providerNameAgrees("TD Garden", "TD Garden"), true);
  assert.equal(providerNameAgrees("故宫", "故宫"), true);
  assert.equal(providerNameAgrees("TD Garden", "BB Garden"), false);
  // Short lowercase Latin words remain noise.
  assert.equal(providerNameAgrees("Jardin de la Ville", "de la"), false);
});

test("a listed acronym matches its expanded provider name; postcodes and astral characters stay safe", () => {
  assert.equal(providerNameAgrees("MoMA", "Museum of Modern Art"), true);
  assert.equal(providerNameAgrees("MoMA PS1", "Museum of Modern Art"), true);
  assert.equal(providerNameAgrees("MoMA", "Metropolitan Opera"), false);
  assert.equal(providerNameAgrees("moma", "Museum of Modern Art"), false);
});

test("names stating different place types never agree", () => {
  assert.equal(providerNameAgrees("Central Garden", "Central Park"), false);
  assert.equal(providerNameAgrees("Central Garden", "Central Gardens"), true);
  assert.equal(providerNameAgrees("Huntington Library, Art Museum and Botanical Gardens", "Huntington Library"), true);
});

test("a coarse name-only result must agree with the listed city or region", () => {
  const georgia = { precision: "region", raw_response: { address: { state: "Georgia", country_code: "us" } } };
  assert.equal(forwardImplausible("name", { name: "Peach Garden", region: "California" }, georgia), "name_result_mismatch");
  assert.equal(forwardImplausible("name", { name: "Peach Garden", region: "Georgia" }, georgia), null);
  const helsinki = { precision: "city", city: "Helsinki", raw_response: { address: { city: "Helsinki" } } };
  assert.equal(forwardImplausible("name", { name: "Photo Biennial", city: "Helsinki" }, helsinki), null);
  assert.equal(forwardImplausible("name", { name: "Photo Biennial", city: "Turku" }, helsinki), "name_result_mismatch");
});

test("a coarse name-only result may match the listed region under any region field", () => {
  const hit = { precision: "region", raw_response: { address: { province: "Ontario", country_code: "ca" } } };
  assert.equal(forwardImplausible("name", { name: "Lakeside Garden", region: "Ontario" }, hit), null);
});

test("a coarse name-only cache hit without its raw response is judged by its parsed region", () => {
  const listed = { name: "Georgia Botanical Garden", region: "Georgia" };
  assert.equal(forwardImplausible("name", listed, { precision: "region", region: "Georgia", raw_response: null }), null);
  assert.equal(
    forwardImplausible("name", listed, { precision: "region", region: "Alabama", raw_response: null }),
    "name_result_mismatch",
  );
});
