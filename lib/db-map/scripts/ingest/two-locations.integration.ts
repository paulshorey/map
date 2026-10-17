/** Real list/detail SQL against isolated temporary rows; all writes roll back. */
import assert from "node:assert/strict";
import { getDb } from "../../lib/db/postgres.js";
import { controlState, workerEvidence } from "../../sql/ingestion-control.js";
import { listPoisGeoJson, getPoiById } from "../../sql/pois.js";
import type { Pool } from "pg";
const db = getDb(),
  client = await db.connect();
try {
  await client.query("BEGIN");
  const gate = await controlState(client);
  assert.equal(gate.maintenance, true);
  assert.equal(
    gate.maintenance_token,
    process.argv[2],
    "owned maintenance required",
  );
  const workers = await workerEvidence(client);
  assert.equal(
    workers.workers.length +
      workers.sourceLocks.length +
      workers.admitted.length,
    0,
  );
  assert.equal(
    (await client.query("SELECT pg_try_advisory_xact_lock(91832,1) acquired"))
      .rows[0].acquired,
    true,
  );
  // Same real columns, but no production data is read or edited by the query fixtures.
  for (const table of [
    "canonical_pois",
    "canonical_categories",
    "canonical_poi_categories",
    "research_pois",
    "research_sources",
  ])
    await client.query(
      `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`,
    );
  const category = "00000000-0000-4000-8000-000000000001";
  await client.query(
    "INSERT INTO canonical_categories(id,slug,display_name,is_active,sort_order) VALUES($1,'test','Test',true,0)",
    [category],
  );
  const one = "00000000-0000-4000-8000-000000000011",
    two = "00000000-0000-4000-8000-000000000012";
  const locations = [
    {
      lat: 46,
      lng: 7,
      origin: "source_coordinates",
      role: "launch",
      precision: "point",
      label: null,
      query: null,
    },
    {
      lat: -36,
      lng: 174,
      origin: "listed_address_geocode",
      role: "alternate",
      precision: "city",
      label: "NZ locality",
      query: "Listed address",
    },
  ];
  await client.query(
    `INSERT INTO canonical_pois(id,name,lat,lng,status,attributes,primary_category_id,popularity)
    VALUES($1,'Two places',46,7,'published',$3::jsonb,$4,2),($2,'Legacy',45,8,'published','{}',$4,1)`,
    [two, one, JSON.stringify({ map_locations: locations }), category],
  );
  const scoped = { query: client.query.bind(client) } as unknown as Pool;
  const base = {
    west: -180,
    east: 180,
    south: -90,
    north: 90,
    category: null,
    limit: 10,
    isWorldView: true,
  };
  const world = (await listPoisGeoJson(scoped, base)) as any;
  assert.equal(world.features.length, 3);
  assert.equal(
    new Set(world.features.map((f: any) => f.id)).size,
    3,
    "unique marker IDs",
  );
  const pair = world.features.filter((f: any) => f.properties.id === two);
  assert.equal(pair.length, 2);
  assert.deepEqual(
    pair.map((f: any) => f.geometry.coordinates),
    [
      [7, 46],
      [174, -36],
    ],
  );
  assert.equal(pair[1].properties.location_precision, "city");
  const viewport = (await listPoisGeoJson(scoped, {
    ...base,
    isWorldView: false,
    west: 170,
    east: 179,
    south: -40,
    north: -30,
  })) as any;
  assert.equal(viewport.features.length, 1);
  assert.equal(
    viewport.features[0].properties.id,
    two,
    "secondary-only viewport includes entity",
  );
  const limited = (await listPoisGeoJson(scoped, { ...base, limit: 1 })) as any;
  assert.equal(
    limited.features.length,
    2,
    "entity limit must not cut away its second marker",
  );
  const detail = await getPoiById(scoped, two);
  assert.deepEqual(detail.locations, locations);
  assert.equal((await getPoiById(scoped, one)).locations.length, 1);
  // Bad, stale, duplicate or excess JSON cannot leak a third marker or fail casts.
  for (const points of [
    locations.concat({ ...locations[1]!, lat: 10 }),
    [locations[0], locations[0]],
    [locations[0], { lat: "bad", lng: 174 }],
    [locations[0], { lat: 0, lng: 0 }],
    [locations[0], { lat: 999, lng: 1 }],
    [{ ...locations[0], lat: 30 }, locations[1]],
  ]) {
    await client.query(
      "UPDATE canonical_pois SET attributes=$2::jsonb WHERE id=$1",
      [two, JSON.stringify({ map_locations: points })],
    );
    const detail = await getPoiById(scoped, two);
    assert.ok(detail.locations.length >= 1 && detail.locations.length <= 2);
    assert.equal(detail.locations.length, points.length === 3 ? 2 : 1);
  }
  console.log(
    "PASS real SQL: world/viewport secondary marker, unique feature IDs/shared detail, entity limits, legacy fallback, malformed/stale/excess/duplicate protection; rollback only",
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await db.end();
}
