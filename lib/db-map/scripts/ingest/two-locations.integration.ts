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
    lat: -36,
    lng: 174,
    kind: "inferred",
    origin: "listed_address_geocode",
    precision: "city",
    label: "NZ locality",
    query: "Listed address",
  };
  const evidence = {
    source_coordinates: sourcePoint,
    inferred_coordinates: inferredPoint,
  };
  await client.query(
    `INSERT INTO canonical_pois(id,name,lat,lng,status,attributes,primary_category_id,popularity)
    VALUES($1,'Two origins',46,7,'published',$3::jsonb,$4,2),($2,'Legacy',45,8,'published','{}',$4,1)`,
    [two, one, JSON.stringify({ coordinate_evidence: evidence }), category],
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
  assert.equal(new Set(world.features.map((f: any) => f.id)).size, 3);
  const pair = world.features.filter((f: any) => f.properties.id === two);
  assert.deepEqual(
    pair.map((f: any) => f.geometry.coordinates),
    [
      [7, 46],
      [174, -36],
    ],
  );
  assert.deepEqual(
    pair.map((f: any) => f.properties.coordinate_kind),
    ["source", "inferred"],
  );
  assert.deepEqual(
    pair.map((f: any) => f.id),
    [`${two}:source`, `${two}:inferred`],
  );
  const viewport = (await listPoisGeoJson(scoped, {
    ...base,
    isWorldView: false,
    west: 170,
    east: 179,
    south: -40,
    north: -30,
  })) as any;
  assert.equal(viewport.features.length, 1);
  assert.equal(viewport.features[0].id, `${two}:inferred`);
  assert.equal(viewport.features[0].properties.id, two);
  assert.equal(
    ((await listPoisGeoJson(scoped, { ...base, limit: 1 })) as any).features
      .length,
    2,
  );
  const detail = await getPoiById(scoped, two);
  assert.deepEqual(detail.coordinate_evidence, evidence);
  assert.equal((await getPoiById(scoped, one)).locations.length, 1);
  assert.equal(
    (await getPoiById(scoped, one)).coordinate_evidence.source_coordinates,
    null,
  );
  // Equality must preserve both named observations while rendering only one marker.
  const equal = {
    ...evidence,
    inferred_coordinates: { ...inferredPoint, lat: 46, lng: 7 },
  };
  await client.query(
    "UPDATE canonical_pois SET attributes=$2::jsonb WHERE id=$1",
    [two, JSON.stringify({ coordinate_evidence: equal })],
  );
  assert.equal((await getPoiById(scoped, two)).locations.length, 1);
  assert.deepEqual((await getPoiById(scoped, two)).coordinate_evidence, equal);
  // Inferred-only coordinates retain their identity; index/absence never relabels them as source.
  await client.query(
    "UPDATE canonical_pois SET lat=-36,lng=174,attributes=$2::jsonb WHERE id=$1",
    [
      two,
      JSON.stringify({
        coordinate_evidence: {
          source_coordinates: null,
          inferred_coordinates: inferredPoint,
        },
      }),
    ],
  );
  const inferredOnly = await getPoiById(scoped, two);
  assert.equal(inferredOnly.locations[0].kind, "inferred");
  assert.equal(inferredOnly.coordinate_evidence.source_coordinates, null);
  await client.query("UPDATE canonical_pois SET lat=46,lng=7 WHERE id=$1", [
    two,
  ]);
  for (const bad of [
    "bad",
    { ...inferredPoint, lat: "bad" },
    { ...inferredPoint, lat: 1e100 },
    { lat: 0, lng: 0 },
    { lat: 999, lng: 1 },
    { ...inferredPoint, kind: "source" },
  ]) {
    await client.query(
      "UPDATE canonical_pois SET attributes=$2::jsonb WHERE id=$1",
      [
        two,
        JSON.stringify({
          coordinate_evidence: {
            source_coordinates: sourcePoint,
            inferred_coordinates: bad,
          },
        }),
      ],
    );
    assert.equal((await getPoiById(scoped, two)).locations.length, 1);
    const invalidViewport = (await listPoisGeoJson(scoped, {
      ...base,
      isWorldView: false,
      west: 170,
      east: 179,
      south: -40,
      north: -30,
    })) as any;
    assert.equal(
      invalidViewport.features.length,
      0,
      "invalid numeric data cannot reach casts or consume viewport markers",
    );
  }
  await client.query(
    "UPDATE canonical_pois SET attributes=$2::jsonb WHERE id=$1",
    [
      two,
      JSON.stringify({
        coordinate_evidence: { ...evidence, third_point: inferredPoint },
      }),
    ],
  );
  assert.equal((await getPoiById(scoped, two)).locations.length, 2);
  // Old role-based arrays remain history; they cannot assign either named bucket.
  await client.query(
    "UPDATE canonical_pois SET attributes=$2::jsonb WHERE id=$1",
    [two, JSON.stringify({ map_locations: [sourcePoint, inferredPoint] })],
  );
  assert.equal((await getPoiById(scoped, two)).locations[0].kind, "legacy");
  console.log(
    "PASS fixed source/inferred buckets, shared detail and stable origin marker IDs, inferred-only viewport, equality preserves both observations, legacy/invalid/excess protection; rollback only",
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await db.end();
}
