import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { Pool } from "pg";
import {
  capturedPoints,
  twoPoints,
} from "../../lib/ingestion/location-points.js";
import { mapGenericRecord } from "./extractors/generic.js";
import { canonicalPoints } from "./canonical-points.js";
import { listedQuery, runGeocode, forwardCacheKey } from "./geocode.js";
import { LOCATION_VERSION } from "./location.js";
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

test("explicit launch/landing survive; malformed/duplicate/excess points cannot add markers", () => {
  const points = [
    { lat: 46, lng: 7, role: "launch" },
    { lat: 46, lng: 7 },
    { lat: 0, lng: 0 },
    { lat: "46", lng: 7 },
    { lat: 46.1, lng: 7.1, role: "landing" },
    { lat: 47, lng: 8 },
  ];
  assert.deepEqual(
    capturedPoints(points).map((p) => p.role),
    ["launch", "landing"],
  );
  assert.equal(
    twoPoints([
      { lat: Infinity, lng: 1 },
      { lat: 91, lng: 2 },
    ]).length,
    0,
  );
  const r = mapGenericRecord({
    id: "flying",
    name: "Site",
    locations: points,
  })!;
  assert.deepEqual([r.lat, r.lng], [46, 7]);
  assert.equal(r.attributes?.locations, points);
  const partial = mapGenericRecord({
    id: "partial",
    name: "Site",
    lat: 12,
    locations: points,
  })!;
  assert.deepEqual(
    [partial.lat, partial.lng],
    [46, 7],
    "never splice two unrelated coordinate pairs",
  );
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
  assert.equal(activated.locations.length, 2);
  assert.deepEqual(
    activated.locations.map((p: any) => [p.lat, p.lng]),
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
  assert.equal(f.activated.locations.length, 1);
});

test("explicit second location outranks a third address candidate; all original evidence remains", async () => {
  const f = fixture({
    ...source,
    region: "Bern",
    attributes: {
      locations: [
        { lat: 6.9185, lng: 7.4402, role: "launch" },
        { lat: 6.9, lng: 7.4, role: "landing" },
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
  });
  assert.equal(
    (await runGeocode(f.db, { ...opts, geocodeLimit: 0 })).apiCalls,
    0,
  );
  assert.deepEqual(
    f.activated.locations.map((p: any) => p.role),
    ["launch", "landing"],
  );
  assert.equal(f.activated.forward.result.lat, 46.9);
});

test("canonical location selection requires active artifact binding and caps mixed-source candidates", () => {
  const row = {
    id: "r",
    source_id: "s",
    source_slug: "source",
    source_trust: 10,
    lat: 46,
    lng: 7,
    coordinate_precision: "point",
    active_normalization_id: "n",
    active_geocode_id: "g",
    location_validation: {
      version: LOCATION_VERSION,
      normalization_id: "n",
      point: { lat: 46, lng: 7 },
      locations: [
        {
          lat: 46,
          lng: 7,
          origin: "source_coordinates",
          role: "launch",
          precision: "point",
        },
        {
          lat: 46.1,
          lng: 7.1,
          origin: "listed_address_geocode",
          role: "alternate",
          precision: "city",
          query: "Locality",
        },
      ],
    },
  };
  assert.equal(canonicalPoints([row], row).length, 2);
  assert.equal(
    canonicalPoints([row], row)[1]!.origin,
    "listed_address_geocode",
  );
  for (const bad of [
    { ...row, active_normalization_id: "other" },
    { ...row, active_geocode_id: null },
    { ...row, lat: 45 },
  ])
    assert.equal(canonicalPoints([bad], bad).length, 1);
  const legacy = { ...row, location_validation: null };
  assert.equal(canonicalPoints([legacy], legacy).length, 1);
  const legacyAnchor = { ...legacy, id: "legacy-anchor", lat: 45.999 };
  assert.equal(
    canonicalPoints([legacyAnchor, row], legacyAnchor)[1]!.lat,
    46.1,
    "address/explicit second location outranks another member's competing primary",
  );
  assert.equal(
    canonicalPoints([row, { ...row, id: "another", source_trust: 100 }], row)
      .length,
    2,
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
    id: "legacy", source_id: "source", source_slug: "source", source_trust: 10,
    lat: 46, lng: 7, coordinate_precision: "city", active_normalization_id: "n",
    active_geocode_id: "g", location_validation: null,
  };
  for (const [coordinate_source, origin] of [
    ["geocode", "geocode"], ["source", "source_coordinates"],
    ["url", "source_coordinates"], [null, "legacy_coordinates"],
    ["unknown", "legacy_coordinates"],
  ]) {
    const member = { ...row, coordinate_source };
    const points = canonicalPoints([member], member);
    assert.equal(points[0]!.origin, origin);
    assert.equal(points[0]!.precision, "city");
    assert.equal(points[0]!.query, null, "legacy geocodes have no validated listed-address query");
  }
});
