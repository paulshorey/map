import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Pool } from "pg";
import {
  readCoordinateEvidence,
  validPoint,
} from "../../lib/ingestion/location-points.js";
import { mapGenericRecord } from "./extractors/generic.js";
import {
  canonicalPoints,
  canonicalCoordinateEvidence,
} from "./canonical-points.js";
import { listedQuery, runGeocode, forwardCacheKey } from "./geocode.js";
import {
  LOCATION_VERSION,
  forwardLocalityConflict,
  localityValue,
  resultNamesListedCity,
} from "./location.js";
import { deriveForwardPrecision } from "../../lib/ingestion/geocode-precision.js";
import { readFileSync } from "node:fs";
import {
  PIPELINE_VERSIONS,
  resumePipelineUpgrade,
} from "./pipeline-versions.js";

const source = {
  name: "Festival",
  address: "Gurtenkulm",
  city: "Köniz",
  region: null,
  country_code: "CH",
  attributes: {},
};
const originalFetch = globalThis.fetch;
const oldKey = process.env.LOCATIONIQ_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (oldKey === undefined) delete process.env.LOCATIONIQ_API_KEY;
  else process.env.LOCATIONIQ_API_KEY = oldKey;
});

function fixture(captured: any = source) {
  const row = {
    id: "poi",
    name: "Festival",
    category_slugs: ["music_festival"],
    lat: 6.9185,
    lng: 7.4402,
    coordinate_source: "source",
    coordinate_precision: "point",
    geocode_query_norm: null,
    active_normalization_id: "normalization",
    canonical_poi_id: null,
    captured,
  };
  const cache = new Map<string, any>();
  let activated: any = null;
  const client = {
    release() {},
    async query(sql: string, args: any[] = []) {
      if (sql.startsWith("SELECT rp.id"))
        return { rows: activated ? [] : [{ id: row.id }] };
      if (sql.startsWith("SELECT rp.*,o.captured")) return { rows: [row] };
      if (sql.startsWith("SELECT slug"))
        return { rows: [{ slug: "music_festival" }] };
      if (
        sql.startsWith("SELECT lat, lng, precision") ||
        sql.startsWith("SELECT payload")
      )
        return { rows: cache.has(args[0]) ? [cache.get(args[0])] : [] };
      if (sql.startsWith("INSERT INTO research_geocode_cache")) {
        const forward = sql.includes("precision, provider, payload");
        cache.set(
          args[0],
          forward
            ? {
                lat: args[1],
                lng: args[2],
                precision: args[3],
                payload: JSON.parse(args[5]),
              }
            : { payload: JSON.parse(args[3]) },
        );
      } else if (sql.includes("INSERT INTO research_poi_geocodes")) {
        return { rows: [{ id: "geocode-new" }] };
      } else if (sql.startsWith("UPDATE research_pois SET lat="))
        activated = JSON.parse(args[6]);
      else
        assert.ok(
          ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql),
          `Unexpected fixture SQL: ${sql}`,
        );
      return { rows: [], rowCount: 1 };
    },
  };
  return {
    row,
    cache,
    get activated() {
      return activated;
    },
    db: { ...client, connect: async () => client } as unknown as Pool,
  };
}
const opts = { recordId: "poi", limit: 1, throttleMs: 0, dryRun: false };

test("saved Sao Paulo cache replays without providers, cache mutation, or coordinate correction", async () => {
  const sao = JSON.parse(
    readFileSync(
      new URL("./fixtures/locationiq-sao-paulo.json", import.meta.url),
      "utf8",
    ),
  );
  const f = fixture({ ...sao.source, attributes: {} });
  f.row.lat = sao.source.lat;
  f.row.lng = sao.source.lng;
  const query = listedQuery(
    { ...f.row, ...sao.source, venue: null, region: null, country_name: null },
    f.row.captured,
    new Set(["music_festival"]),
  )!;
  f.cache.set(forwardCacheKey(query.norm, "BR"), {
    lat: sao.forward.result.lat,
    lng: sao.forward.result.lng,
    precision: "point",
    payload: { hit: sao.forward.result },
  });
  f.cache.set(`location-v2:reverse:${f.row.lat}:${f.row.lng}`, {
    payload: { hit: null },
  });
  const before = structuredClone([...f.cache]);
  globalThis.fetch = async () => {
    throw new Error("Paid caches must be reused");
  };
  const stats = await runGeocode(f.db, opts);
  assert.equal(stats.apiCalls, 0);
  assert.equal(stats.cacheHits, 2);
  assert.deepEqual([...f.cache], before);
  assert.deepEqual(f.activated.point, {
    lat: sao.source.lat,
    lng: sao.source.lng,
  });
  const inferred = f.activated.coordinate_evidence.inferred_coordinates;
  assert.deepEqual(
    [inferred.lat, inferred.lng],
    [sao.forward.result.lat, sao.forward.result.lng],
  );
  assert.equal(inferred.precision_evidence.derivation, "legacy_cache");
  assert.ok(
    inferred.precision_evidence.warnings.includes(
      "provider_granularity_missing",
    ),
  );
  assert.equal(f.activated.forward.result.raw_response, undefined);
});

test("raw source locations remain raw evidence and do not occupy either typed slot", () => {
  const locations = [
    { lat: 46, lng: 7, role: "launch" },
    { lat: 46.1, lng: 7.1, role: "landing" },
  ];
  const r = mapGenericRecord({
    id: "flying",
    name: "Site",
    lat: 47,
    lng: 8,
    locations,
  })!;
  assert.deepEqual([r.lat, r.lng], [47, 8]);
  assert.equal(r.attributes?.locations, locations);
  const unclassified = mapGenericRecord({
    id: "unclassified",
    name: "Site",
    locations,
  })!;
  assert.equal(unclassified.lat, undefined);
  assert.equal(unclassified.lng, undefined);
  assert.equal(validPoint({ lat: 0, lng: 0 }), false);
  assert.equal(validPoint({ lat: Infinity, lng: 7 }), false);
});

test("address query is based on captured text/hints, never reverse-generated projection", () => {
  const row: any = {
    name: "Wrong model",
    address: "Wrong reverse road",
    city: "Wrong city",
    region: "Wrong region",
    country_name: "Wrong",
    category_slugs: ["music_festival"],
  };
  const q = listedQuery(row, source, new Set(["music_festival"]))!;
  assert.equal(q.display, "Gurtenkulm, Köniz, CH");
  const venice = listedQuery(
    row,
    {
      ...source,
      name: "Venice Biennale",
      address: "Castello, Venice",
      city: "Venice",
      country_code: "IT",
      attributes: { venue_name: "Giardini and Arsenale" },
    },
    new Set(["music_festival"]),
  )!;
  assert.equal(
    venice.display,
    "Castello, Venice, Venice, IT",
    "combined venue names must not steer an address lookup to an unrelated business",
  );
  const hints = listedQuery(
    row,
    {
      name: "Edition",
      attributes: {
        source_location_hints: { city: "Auckland", country: "NZ" },
      },
    },
    new Set(["music_festival"]),
  )!;
  assert.equal(hints.display, "Auckland, NZ");
});

test("contradictory source/address points both activate atomically; budget resume reuses paid lookup", async () => {
  const f = fixture();
  process.env.LOCATIONIQ_API_KEY = "fixture";
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/search"))
      assert.equal(u.searchParams.get("countrycodes"), "ch");
    calls.push(u.pathname);
    assert.equal(
      f.activated,
      null,
      "neither lookup can activate a partial artifact",
    );
    if (u.pathname.endsWith("/search"))
      return Response.json([
        {
          lat: "46.9185",
          lon: "7.4402",
          type: "attraction",
          display_name: "Swiss venue",
          address: { city: "Köniz", country_code: "ch" },
        },
      ]);
    return Response.json({
      lat: "6.9185",
      lon: "7.4402",
      address: { country_code: "ng", city: "Aka", state: "Enugu" },
    });
  };
  const first = await runGeocode(f.db, { ...opts, geocodeLimit: 1 });
  assert.equal(first.budgetHit, true);
  assert.equal(f.activated, null);
  assert.equal(f.cache.size, 1);
  const second = await runGeocode(f.db, { ...opts, geocodeLimit: 1 });
  assert.equal(second.cacheHits, 1);
  assert.equal(second.apiCalls, 1);
  const activated = f.activated as any;
  assert.ok(activated.coordinate_evidence.source_coordinates);
  assert.ok(activated.coordinate_evidence.inferred_coordinates);
  assert.deepEqual(
    Object.values(activated.coordinate_evidence).map((p: any) => [
      p.lat,
      p.lng,
    ]),
    [
      [6.9185, 7.4402],
      [46.9185, 7.4402],
    ],
  );
  assert.equal(activated.listed.country_code, "CH");
  assert.equal(activated.reverse.country_code, "NG");
  assert.ok(activated.warnings.includes("coordinate_country_conflict"));
  assert.deepEqual(calls, ["/v1/search", "/v1/reverse"]);
  assert.equal((await runGeocode(f.db, opts)).selected, 0);
});

test("forward miss does not discard an existing source point; known miss is cacheable", async () => {
  const f = fixture({ ...source, region: "Bern" });
  process.env.LOCATIONIQ_API_KEY = "fixture";
  globalThis.fetch = async () =>
    Response.json({ error: "Unable to geocode" }, { status: 404 });
  const result = await runGeocode(f.db, { ...opts, geocodeLimit: 1 });
  assert.equal(result.resolved, 1);
  assert.equal(f.activated.forward.state, "miss");
  assert.ok(f.activated.coordinate_evidence.source_coordinates);
  assert.equal(f.activated.coordinate_evidence.inferred_coordinates, null);
});

test("a second source point cannot displace the independently inferred point", async () => {
  const f = fixture({
    ...source,
    region: "Bern",
    attributes: {
      locations: [
        { lat: 6.9185, lng: 7.4402 },
        { lat: 6.9, lng: 7.4 },
      ],
    },
  });
  const q = listedQuery(
    f.row as any,
    f.row.captured,
    new Set(["music_festival"]),
  )!;
  f.cache.set(forwardCacheKey(q.norm, "CH"), {
    lat: 46.9,
    lng: 7.4,
    precision: "city",
    payload: { hit: { city: "Köniz" } },
  });
  assert.equal(
    (await runGeocode(f.db, { ...opts, geocodeLimit: 0 })).apiCalls,
    0,
  );
  assert.deepEqual(
    [
      f.activated.coordinate_evidence.source_coordinates.lat,
      f.activated.coordinate_evidence.inferred_coordinates.lat,
    ],
    [6.9185, 46.9],
  );
  assert.equal(
    f.activated.coordinate_evidence.inferred_coordinates.kind,
    "inferred",
  );
});

test("address-only input keeps the source slot empty", async () => {
  const f = fixture({ ...source, region: "Bern" });
  Object.assign(f.row, {
    lat: null,
    lng: null,
    coordinate_source: null,
    coordinate_precision: null,
  });
  const q = listedQuery(
    f.row as any,
    f.row.captured,
    new Set(["music_festival"]),
  )!;
  f.cache.set(forwardCacheKey(q.norm, "CH"), {
    lat: 46.9,
    lng: 7.4,
    precision: "city",
    payload: { hit: { city: "Köniz" } },
  });
  await runGeocode(f.db, { ...opts, geocodeLimit: 0 });
  assert.equal(f.activated.coordinate_evidence.source_coordinates, null);
  assert.equal(f.activated.coordinate_evidence.inferred_coordinates.lat, 46.9);
});

test("canonical buckets are selected independently by provenance, with exact artifact binding", () => {
  const sourcePoint = {
    lat: 46,
    lng: 7,
    kind: "source",
    origin: "source_coordinates",
    precision: "point",
    label: null,
    query: null,
  };
  const inferredPoint = {
    ...sourcePoint,
    lat: 46.1,
    kind: "inferred",
    origin: "listed_address_geocode",
    query: "Listed locality",
  };
  const row = {
    id: "r",
    source_id: "s",
    source_slug: "source",
    source_trust: 10,
    lat: 46,
    lng: 7,
    coordinate_source: "source",
    coordinate_precision: "point",
    active_normalization_id: "n",
    active_geocode_id: "g",
    location_validation: {
      version: LOCATION_VERSION,
      normalization_id: "n",
      point: { lat: 46, lng: 7 },
      coordinate_evidence: {
        source_coordinates: sourcePoint,
        inferred_coordinates: inferredPoint,
      },
    },
  };
  const e = canonicalCoordinateEvidence([row], row);
  assert.equal(e.source_coordinates!.lat, 46);
  assert.equal(e.inferred_coordinates!.lat, 46.1);
  for (const bad of [
    { ...row, active_normalization_id: "other" },
    { ...row, active_geocode_id: null },
    { ...row, lat: 45 },
  ]) {
    const invalid = canonicalCoordinateEvidence([bad], bad);
    assert.equal(invalid.inferred_coordinates, null);
    assert.equal(invalid.source_coordinates!.kind, "source");
  }
  const other = {
    ...row,
    id: "other",
    source_trust: 100,
    location_validation: null,
  };
  const combined = canonicalCoordinateEvidence([row, other], other);
  assert.equal(combined.source_coordinates!.research_id, "other");
  assert.equal(combined.inferred_coordinates!.research_id, "r");
  const geocoded = { ...other, coordinate_source: "geocode" };
  const legacy = canonicalCoordinateEvidence([geocoded], geocoded);
  assert.deepEqual(legacy, {
    source_coordinates: null,
    inferred_coordinates: null,
  });
  assert.equal(canonicalPoints([geocoded], geocoded)[0]!.origin, "geocode");
  const equal = readCoordinateEvidence({
    source_coordinates: sourcePoint,
    inferred_coordinates: { ...inferredPoint, lat: 46 },
  });
  assert.ok(
    equal.source_coordinates && equal.inferred_coordinates,
    "equal numeric points retain both provenance records",
  );
  assert.equal(
    readCoordinateEvidence({ source_coordinates: inferredPoint })
      .source_coordinates,
    null,
    "slot kind must match origin",
  );
});

test("single-location pipeline checkpoints remain structurally compatible without a backfill", () => {
  const previous = {
    ...PIPELINE_VERSIONS,
    geocode: "locationiq-location-v2",
    canonicalBuilder: "canonical-build-v2",
  };
  assert.ok(resumePipelineUpgrade(previous));
  assert.throws(
    () => resumePipelineUpgrade({ ...previous, matcher: "unreviewed" }),
    /Pipeline versions changed/,
  );
});

test("legacy canonical points retain known coordinate provenance without inventing evidence", () => {
  const row = {
    id: "legacy",
    source_id: "source",
    source_slug: "source",
    source_trust: 10,
    lat: 46,
    lng: 7,
    coordinate_precision: "city",
    active_normalization_id: "n",
    active_geocode_id: "g",
    location_validation: null,
  };
  for (const [coordinate_source, origin] of [
    ["geocode", "geocode"],
    ["source", "source_coordinates"],
    ["url", "source_coordinates"],
    [null, "legacy_coordinates"],
    ["unknown", "legacy_coordinates"],
  ]) {
    const member = { ...row, coordinate_source };
    const points = canonicalPoints([member], member);
    assert.equal(points[0]!.origin, origin);
    assert.equal(points[0]!.precision, "city");
    assert.equal(
      points[0]!.query,
      null,
      "legacy geocodes have no validated listed-address query",
    );
  }
});

for (const found of [true, false])
  test(`retained legacy geocode never inherits a different new query (forward ${found ? "hit" : "miss"})`, async () => {
    const f = fixture({ ...source, region: "Bern" });
    f.row.coordinate_source = "geocode";
    const q = listedQuery(
      f.row as any,
      f.row.captured,
      new Set(["music_festival"]),
    )!;
    f.cache.set(
      forwardCacheKey(q.norm, "CH"),
      found
        ? {
            lat: 46.9,
            lng: 7.4,
            precision: "city",
            payload: { hit: { city: "Köniz" } },
          }
        : { lat: null, lng: null, precision: null, payload: { hit: null } },
    );
    await runGeocode(f.db, { ...opts, geocodeLimit: 0 });
    const evidence = f.activated.coordinate_evidence;
    assert.equal(evidence.source_coordinates, null);
    assert.equal(
      f.activated.point.lat,
      6.9185,
      "the historical primary remains separately identified",
    );
    if (found) {
      assert.equal(evidence.inferred_coordinates.lat, 46.9);
      assert.equal(evidence.inferred_coordinates.query, q.display);
    } else {
      assert.equal(
        evidence.inferred_coordinates,
        null,
        "a miss cannot certify the old point with a new query",
      );
      const row = {
        ...f.row,
        id: "legacy",
        source_id: "s",
        source_slug: "source",
        source_trust: 10,
        location_validation: f.activated,
        active_geocode_id: "current-artifact",
      };
      const old = canonicalPoints([row], row)[0]!;
      assert.equal(old.origin, "geocode");
      assert.equal(old.query, null);
    }
  });

const japan = { name: "Aichi Triennale", city: "Nagoya", country_code: "JP" };
const urayasu = {
  lat: "35.634313",
  lon: "139.879606",
  display_name: "Center Street, Urayasu, Urayasu, Chiba Prefecture, Japan",
  address: {
    road: "Center Street",
    city: "Urayasu",
    state: "Chiba Prefecture",
    country: "Japan",
    country_code: "jp",
  },
};

test("placeholder locality never reaches the geocoder; a country-only lookup beside a source point is skipped", () => {
  const temporal = new Set(["music_festival"]);
  const row: any = {
    category_slugs: ["music_festival"],
    lat: -25.2744,
    lng: 133.7751,
    coordinate_source: "source",
  };
  const adelaide = {
    name: "Adelaide Biennial of Australian Art",
    city: "Various",
    attributes: { venue_name: "Various venues", country_name: "Australia" },
  };
  assert.equal(localityValue("Various venues"), null);
  assert.equal(localityValue("TBA."), null);
  assert.equal(localityValue("Variety Theatre"), "Variety Theatre");
  assert.equal(listedQuery(row, adelaide, temporal), null);
  assert.equal(
    listedQuery({ ...row, coordinate_source: "url" }, adelaide, temporal),
    null,
  );
  for (const coordinate_source of ["geocode", null, undefined]) {
    assert.equal(
      listedQuery({ ...row, coordinate_source }, adelaide, temporal)!.display,
      "Australia",
      `country evidence is still queried for ${coordinate_source} coordinates`,
    );
  }
  const missing = listedQuery(
    { ...row, lat: null, lng: null },
    adelaide,
    temporal,
  )!;
  assert.equal(
    missing.display,
    "Australia",
    "no source point: the country is the only listed evidence",
  );
  assert.equal(
    listedQuery(row, { ...adelaide, city: "Adelaide" }, temporal)!.display,
    "Adelaide, Australia",
  );
});

test("a legacy geocoded point still obtains country-level inferred evidence", async () => {
  const f = fixture({
    name: "AFiRIperFOMA",
    country_code: "NG",
    attributes: {},
  });
  f.row.coordinate_source = "geocode";
  f.cache.set(`location-v2:reverse:${f.row.lat}:${f.row.lng}`, {
    payload: { hit: null },
  });
  process.env.LOCATIONIQ_API_KEY = "fixture";
  const queries: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.ok(url.pathname.endsWith("/search"));
    queries.push(url.searchParams.get("q")!);
    return Response.json([
      {
        lat: "9.6000359",
        lon: "7.9999721",
        type: "administrative",
        class: "boundary",
        display_name: "Nigeria",
        address: { country: "Nigeria", country_code: "ng" },
      },
    ]);
  };
  const stats = await runGeocode(f.db, opts);
  assert.deepEqual(queries, ["NG"]);
  assert.equal(stats.apiCalls, 1);
  assert.equal(f.activated.coordinate_evidence.source_coordinates, null);
  const inferred = f.activated.coordinate_evidence.inferred_coordinates;
  assert.deepEqual(
    [inferred.lat, inferred.lng, inferred.precision, inferred.query],
    [9.6000359, 7.9999721, "country", "NG"],
  );
});

test("a city-only miss never confirms a conflicting venue without a source point", async () => {
  const f = fixture({
    ...japan,
    attributes: { venue_name: "Aichi Arts Center" },
  });
  Object.assign(f.row, {
    lat: null,
    lng: null,
    coordinate_source: null,
    coordinate_precision: null,
  });
  process.env.LOCATIONIQ_API_KEY = "fixture";
  const queries: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.ok(
      url.pathname.endsWith("/search"),
      "no rejected point is reverse geocoded",
    );
    const q = url.searchParams.get("q")!;
    queries.push(q);
    return q.startsWith("Aichi Arts Center")
      ? Response.json([urayasu])
      : Response.json({ error: "Unable to geocode" }, { status: 404 });
  };
  const stats = await runGeocode(f.db, opts);
  assert.deepEqual(queries, ["Aichi Arts Center, Nagoya, JP", "Nagoya, JP"]);
  assert.equal(stats.apiCalls, 2);
  assert.equal(stats.unresolved, 1);
  assert.equal(stats.resolved, 0);
  assert.equal(f.activated, null, "a wrong venue must not become publishable");
  assert.equal(
    f.cache.size,
    2,
    "both the paid hit and definitive miss are retained",
  );
  const replay = await runGeocode(f.db, opts);
  assert.equal(replay.apiCalls, 0);
  assert.equal(replay.cacheHits, 2);
  assert.equal(replay.knownMisses, 1);
  assert.equal(replay.unresolved, 1);
  assert.equal(f.activated, null);
});

test("forward locality conflict compares Latin-script locality and never flags unreadable labels", () => {
  const hit = (row: any) => ({
    label: row.display_name,
    city: row.address?.city ?? null,
    region: row.address?.state ?? null,
    raw_response: row,
  });
  assert.equal(forwardLocalityConflict("Nagoya", hit(urayasu)), true);
  const nagoya = { lat: 35.1815, lng: 136.9066 };
  assert.equal(
    forwardLocalityConflict(
      "Nagoya",
      { ...hit(urayasu), lat: 35.634313, lng: 139.879606 },
      nagoya,
    ),
    true,
    "274 km from the source point",
  );
  const venezia = {
    lat: 45.4344,
    lng: 12.3536,
    city: "Venezia",
    region: "Veneto",
    label: "Castello, Venezia, Veneto, Italia",
  };
  assert.equal(
    forwardLocalityConflict("Venice", venezia, { lat: 45.4286, lng: 12.3602 }),
    false,
    "an exonym near the source point is the listed city",
  );
  assert.equal(
    forwardLocalityConflict("Venice", venezia),
    true,
    "without an anchor the name mismatch is only a suspicion for the city retry",
  );
  const japanese = {
    ...hit({
      display_name: "東桜二丁目, 東区, 名古屋市, 愛知県, 461-0005, 日本",
      address: { city: "名古屋市", state: "愛知県", country_code: "jp" },
    }),
    lat: 35.171876,
    lng: 136.916736,
  };
  assert.equal(resultNamesListedCity("Nagoya", japanese), false);
  assert.equal(resultNamesListedCity("名古屋市", japanese), true);
  assert.equal(
    forwardLocalityConflict("Nagoya", japanese, nagoya),
    false,
    "an unreadable label near the source point is kept",
  );
  assert.equal(
    forwardLocalityConflict("Nagoya", japanese),
    true,
    "an unreadable label without an anchor is verified by the city lookup",
  );
  assert.equal(
    forwardLocalityConflict("Köniz", { label: "Swiss venue" }),
    true,
    "a label alone never confirms the listed city",
  );
  assert.equal(
    forwardLocalityConflict(
      "Washington, D.C.",
      hit({
        display_name:
          "National Mall, Washington, District of Columbia, United States",
        address: { city: "Washington", state: "District of Columbia" },
      }),
    ),
    false,
  );
  assert.equal(forwardLocalityConflict("Various", hit(urayasu)), false);
});

test("the listed city must match a whole city-level name; states, counties and countries never confirm it", () => {
  const wichita = {
    city: "Wichita",
    region: "Kansas",
    label: "Old Town, Wichita, Sedgwick County, Kansas, United States",
    raw_response: {
      address: {
        city: "Wichita",
        county: "Sedgwick County",
        state: "Kansas",
        country: "United States",
      },
    },
  };
  assert.equal(resultNamesListedCity("Kansas City", wichita), false);
  assert.equal(
    forwardLocalityConflict(
      "Kansas City",
      { ...wichita, lat: 37.6872, lng: -97.3301 },
      { lat: 39.0997, lng: -94.5786 },
    ),
    true,
    "Kansas City is never reduced to Kansas; Wichita is 280 km away",
  );
  assert.equal(
    resultNamesListedCity("Kansas City, MO", {
      raw_response: { address: { city: "Kansas City", state: "Missouri" } },
    }),
    true,
  );
  assert.equal(
    resultNamesListedCity("Mexico City", {
      label: "Monterrey, Nuevo León, México",
      raw_response: {
        address: { city: "Monterrey", state: "Nuevo León", country: "México" },
      },
    }),
    false,
    "a country name in the label does not confirm Mexico City",
  );
  assert.equal(
    resultNamesListedCity("York", {
      raw_response: { address: { city: "New York" } },
    }),
    false,
    "a shorter listed name is not a substring match",
  );
  assert.equal(
    resultNamesListedCity("Orange", {
      raw_response: { address: { county: "Orange County", city: "Anaheim" } },
    }),
    false,
  );
  assert.equal(
    resultNamesListedCity("St. Louis", {
      raw_response: { address: { city: "Saint Louis" } },
    }),
    true,
  );
  assert.equal(
    resultNamesListedCity("Sydney", {
      raw_response: { address: { city: "City of Sydney" } },
    }),
    true,
  );
  assert.equal(
    resultNamesListedCity("Brooklyn", {
      raw_response: { address: { city: "New York", suburb: "Brooklyn" } },
    }),
    true,
  );
});

test("a native-script listed city is verified, never waved through", () => {
  const venue = {
    lat: 35.634313,
    lng: 139.879606,
    city: "Urayasu",
    raw_response: { address: { city: "Urayasu", state: "Chiba Prefecture" } },
  };
  assert.equal(resultNamesListedCity("名古屋市", venue), false);
  assert.equal(
    forwardLocalityConflict("名古屋市", venue),
    true,
    "no source point: the city-only retry must confirm it",
  );
  assert.equal(
    forwardLocalityConflict("名古屋市", venue, { lat: 35.1815, lng: 136.9066 }),
    true,
    "274 km from the source point",
  );
  const sameCity = {
    lat: 35.1719,
    lng: 136.9167,
    city: "名古屋市",
    raw_response: { address: { city: "名古屋市", state: "愛知県" } },
  };
  assert.equal(forwardLocalityConflict("名古屋市", sameCity), false);
  assert.equal(
    forwardLocalityConflict("Москва", {
      lat: 55.75,
      lng: 37.62,
      city: "Москва",
    }),
    false,
  );
  assert.equal(
    forwardLocalityConflict(null, venue),
    false,
    "no listed city: nothing to retry with",
  );
});

test("ambiguous quantifiers are filler only with a noun; a town named Many is kept", () => {
  assert.equal(localityValue("Many"), "Many");
  assert.equal(localityValue("Many venues"), null);
  assert.equal(localityValue("Multiple locations"), null);
  assert.equal(localityValue("Several cities"), null);
  assert.equal(localityValue("Various"), null);
  assert.equal(localityValue("Online"), null);
});

test("country boundary results are classified as country precision", () => {
  const nigeria = {
    lat: "9.6000359",
    lon: "7.9999721",
    type: "administrative",
    class: "boundary",
    display_name: "Nigeria",
    address: { country: "Nigeria", country_code: "ng" },
  };
  assert.deepEqual(
    [
      deriveForwardPrecision(nigeria).value,
      deriveForwardPrecision(nigeria).derivation,
    ],
    ["country", "provider_address"],
  );
  assert.equal(deriveForwardPrecision({ type: "country" }).value, "country");
  assert.equal(
    deriveForwardPrecision({
      type: "administrative",
      address: { city: "Kaduna", country_code: "ng" },
    }).value,
    "city",
  );
});

test("a venue lookup in another city is kept only as rejected evidence and retried by listed city", async () => {
  const f = fixture({
    ...japan,
    attributes: { venue_name: "Aichi Arts Center" },
  });
  Object.assign(f.row, { lat: 35.1815, lng: 136.9066 });
  f.cache.set(`location-v2:reverse:35.1815:136.9066`, {
    payload: { hit: null },
  });
  process.env.LOCATIONIQ_API_KEY = "fixture";
  const queries: string[] = [];
  globalThis.fetch = async (input) => {
    const q = new URL(String(input)).searchParams.get("q")!;
    queries.push(q);
    return Response.json([
      q.startsWith("Aichi Arts Center")
        ? urayasu
        : {
            lat: "35.1851",
            lon: "136.8994",
            type: "city",
            class: "place",
            display_name: "Nagoya, Aichi Prefecture, Japan",
            address: {
              city: "Nagoya",
              state: "Aichi Prefecture",
              country_code: "jp",
            },
          },
    ]);
  };
  const stats = await runGeocode(f.db, opts);
  assert.deepEqual(queries, ["Aichi Arts Center, Nagoya, JP", "Nagoya, JP"]);
  assert.equal(stats.apiCalls, 2);
  const inferred = f.activated.coordinate_evidence.inferred_coordinates;
  assert.deepEqual(
    [inferred.lat, inferred.lng, inferred.precision],
    [35.1851, 136.8994, "city"],
  );
  assert.equal(inferred.query, "Nagoya, JP");
  assert.equal(
    f.activated.forward.rejected.reason,
    "forward_locality_conflict",
  );
  assert.equal(f.activated.forward.rejected.result.city, "Urayasu");
  assert.equal(f.activated.coordinate_evidence.source_coordinates.lat, 35.1815);
});

test("canonical inferred slot prefers an address lookup over the anchor's conflicting venue lookup", () => {
  const member = (
    id: string,
    trust: number,
    listed: Record<string, unknown>,
    lat: number,
    lng: number,
    result: Record<string, unknown> | null,
  ) => ({
    id,
    source_id: id,
    source_slug: id,
    source_trust: trust,
    lat: 35.1815,
    lng: 136.9066,
    coordinate_source: "source",
    coordinate_precision: "point",
    active_normalization_id: `n-${id}`,
    active_geocode_id: `g-${id}`,
    location_validation: {
      version: LOCATION_VERSION,
      normalization_id: `n-${id}`,
      point: { lat: 35.1815, lng: 136.9066 },
      listed,
      forward: { result: result && { ...result, lat, lng } },
      coordinate_evidence: {
        source_coordinates: {
          lat: 35.1815,
          lng: 136.9066,
          kind: "source",
          origin: "source_coordinates",
          precision: "point",
          label: null,
          query: null,
        },
        inferred_coordinates: {
          lat,
          lng,
          kind: "inferred",
          origin: "listed_address_geocode",
          precision: "point",
          label: null,
          query: "q",
        },
      },
    },
  });
  const anchor = member(
    "biennial_foundation",
    90,
    { city: "Nagoya", address: null },
    35.634313,
    139.879606,
    {
      city: "Urayasu",
      region: "Chiba Prefecture",
      label: urayasu.display_name,
      raw_response: urayasu,
    },
  );
  const address = member(
    "biennale_com",
    50,
    { city: "Nagoya", address: "1-13-2 Higashisakura, Higashi-ku" },
    35.171876,
    136.916736,
    { city: "名古屋市", label: "東桜二丁目, 東区, 名古屋市, 愛知県, 日本" },
  );
  const e = canonicalCoordinateEvidence([anchor, address], anchor);
  assert.equal(e.source_coordinates!.research_id, "biennial_foundation");
  assert.equal(e.inferred_coordinates!.research_id, "biennale_com");
  assert.equal(e.inferred_coordinates!.lat, 35.171876);
  // Without a conflict, a supplied street address still outranks venue text.
  const venue = member(
    "venue",
    90,
    { city: "Nagoya", address: null },
    35.17,
    136.91,
    null,
  );
  assert.equal(
    canonicalCoordinateEvidence([venue, address], venue).inferred_coordinates!
      .research_id,
    "biennale_com",
  );
  // Equal evidence keeps the existing anchor/trust order.
  const peer = member(
    "peer",
    10,
    { city: "Nagoya", address: null },
    35.18,
    136.9,
    null,
  );
  assert.equal(
    canonicalCoordinateEvidence([venue, peer], venue).inferred_coordinates!
      .research_id,
    "venue",
  );
  const cityFallback = member(
    "city-fallback",
    100,
    { city: "Nagoya", address: "1-13-2 Higashisakura, Higashi-ku" },
    35.1851,
    136.8994,
    { city: "Nagoya" },
  );
  cityFallback.location_validation.coordinate_evidence.inferred_coordinates.precision =
    "city";
  Object.assign(cityFallback.location_validation.forward, {
    rejected: { reason: "forward_locality_conflict", result: urayasu },
  });
  assert.equal(
    canonicalCoordinateEvidence([cityFallback, venue], cityFallback)
      .inferred_coordinates!.research_id,
    "venue",
    "a city fallback must not inherit the rejected address lookup's rank",
  );
});

test("an exonym result confirmed by the listed city's own lookup is kept, not rejected", async () => {
  const f = fixture({
    name: "Venice Biennale",
    city: "Venice",
    country_code: "IT",
    attributes: { venue_name: "Giardini" },
  });
  Object.assign(f.row, {
    lat: null,
    lng: null,
    coordinate_source: null,
    coordinate_precision: null,
  });
  process.env.LOCATIONIQ_API_KEY = "fixture";
  const queries: string[] = [];
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/reverse"))
      return Response.json({
        lat: "45.4286",
        lon: "12.3602",
        address: { country_code: "it", city: "Venezia", state: "Veneto" },
      });
    const q = u.searchParams.get("q")!;
    queries.push(q);
    return Response.json([
      q.startsWith("Giardini")
        ? {
            lat: "45.4286",
            lon: "12.3602",
            class: "leisure",
            type: "park",
            display_name: "Giardini, Castello, Venezia, Veneto, Italia",
            address: { city: "Venezia", state: "Veneto", country_code: "it" },
          }
        : {
            lat: "45.4372",
            lon: "12.3346",
            class: "place",
            type: "city",
            display_name: "Venezia, Veneto, Italia",
            address: { city: "Venezia", state: "Veneto", country_code: "it" },
          },
    ]);
  };
  await runGeocode(f.db, opts);
  assert.deepEqual(queries, ["Giardini, Venice, IT", "Venice, IT"]);
  const inferred = f.activated.coordinate_evidence.inferred_coordinates;
  assert.deepEqual(
    [inferred.lat, inferred.lng, inferred.query],
    [45.4286, 12.3602, "Giardini, Venice, IT"],
  );
  assert.equal(f.activated.forward.rejected, undefined);
  assert.equal(f.activated.forward.city_confirmation.query, "Venice, IT");
  const confirmed = {
    id: "confirmed",
    source_id: "confirmed",
    source_slug: "confirmed",
    source_trust: 90,
    lat: inferred.lat,
    lng: inferred.lng,
    coordinate_source: "geocode",
    coordinate_precision: "point",
    active_normalization_id: f.row.active_normalization_id,
    active_geocode_id: "geocode-new",
    location_validation: f.activated,
  };
  const city = {
    ...confirmed,
    id: "city",
    source_id: "city",
    source_slug: "city",
    source_trust: 50,
    location_validation: {
      ...f.activated,
      forward: { result: null },
      coordinate_evidence: {
        source_coordinates: null,
        inferred_coordinates: { ...inferred, precision: "city" },
      },
    },
  };
  assert.equal(
    canonicalCoordinateEvidence([confirmed, city], confirmed)
      .inferred_coordinates!.research_id,
    "confirmed",
    "a confirmed exonym must stay nonconflicting during canonical ranking",
  );
});

test("canonical ranking reads city and address from source location hints like the lookup does", () => {
  const member = (
    id: string,
    trust: number,
    listed: Record<string, unknown>,
    lat: number,
    lng: number,
    result: Record<string, unknown> | null,
  ) => ({
    id,
    source_id: id,
    source_slug: id,
    source_trust: trust,
    lat: null,
    lng: null,
    coordinate_source: null,
    coordinate_precision: null,
    active_normalization_id: `n-${id}`,
    active_geocode_id: `g-${id}`,
    location_validation: {
      version: LOCATION_VERSION,
      normalization_id: `n-${id}`,
      point: { lat: null, lng: null },
      listed,
      forward: { result: result && { ...result, lat, lng } },
      coordinate_evidence: {
        source_coordinates: null,
        inferred_coordinates: {
          lat,
          lng,
          kind: "inferred",
          origin: "listed_address_geocode",
          precision: "point",
          label: null,
          query: "q",
        },
      },
    },
  });
  // Rows have no point of their own; the validation binding below is what memberEvidence reads.
  const bind = (m: ReturnType<typeof member>) => ({
    ...m,
    lat: m.location_validation.coordinate_evidence.inferred_coordinates.lat,
    lng: m.location_validation.coordinate_evidence.inferred_coordinates.lng,
    location_validation: {
      ...m.location_validation,
      point: {
        lat: m.location_validation.coordinate_evidence.inferred_coordinates.lat,
        lng: m.location_validation.coordinate_evidence.inferred_coordinates.lng,
      },
    },
  });
  const wichita = bind(
    member(
      "venue",
      90,
      { city: null, address: null, hints: { city: "Kansas City" } },
      37.6872,
      -97.3301,
      {
        city: "Wichita",
        region: "Kansas",
        raw_response: { address: { city: "Wichita", state: "Kansas" } },
      },
    ),
  );
  const hinted = bind(
    member(
      "hinted",
      10,
      {
        city: null,
        address: null,
        hints: { city: "Kansas City", location: "1601 Broadway Blvd" },
      },
      39.0943,
      -94.5867,
      {
        city: "Kansas City",
        raw_response: { address: { city: "Kansas City", state: "Missouri" } },
      },
    ),
  );
  const e = canonicalCoordinateEvidence([wichita, hinted], wichita);
  assert.equal(
    e.inferred_coordinates!.research_id,
    "hinted",
    "the hinted city exposes Wichita's conflict and the hinted address earns priority",
  );
});
