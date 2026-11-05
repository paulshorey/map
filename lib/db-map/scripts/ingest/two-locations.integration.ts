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
    "canonical_poi_locations",
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
    two = "00000000-0000-4000-8000-000000000012",
    build = "00000000-0000-4000-8000-000000000099";
  await client.query(
    `INSERT INTO canonical_pois(id,name,lat,lng,status,attributes,primary_category_id,popularity,active_build_id)
    VALUES($1,'Many locations',46,7,'published','{}',$3,2,$4),($2,'Legacy',45,8,'published','{}',$3,1,NULL)`,
    [two, one, category, build],
  );
  const location = (
    id: string,
    lat: number,
    lng: number,
    precision: string,
    kind: string,
    origin: string,
    primary: boolean,
    ordinal: number,
  ) =>
    client.query(
      `INSERT INTO canonical_poi_locations(id,canonical_poi_id,build_id,lat,lng,precision,specificity,kinds,origins,roles,
        label,is_primary,research_location_ids,research_poi_ids,sources,ordinal)
      VALUES($1,$2,$3,$4,$5,$6,$7,ARRAY[$8],ARRAY[$9],ARRAY['venue'],NULL,$10,ARRAY[$1]::uuid[],ARRAY[$2]::uuid[],ARRAY['test'],$11)`,
      [id, two, build, lat, lng, precision, precision === "point" ? "precise" : "general", kind, origin, primary, ordinal],
    );
  const L1 = "00000000-0000-4000-8000-0000000000a1",
    L2 = "00000000-0000-4000-8000-0000000000a2",
    L3 = "00000000-0000-4000-8000-0000000000a3";
  await location(L1, 46, 7, "point", "source", "source_coordinates", true, 0);
  await location(L2, -36, 174, "city", "inferred", "listed_address_geocode", false, 1);
  await location(L3, 35.18, 136.9, "point", "source", "source_coordinates", false, 2);
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
  assert.equal(world.features.length, 4, "every known location is a marker, plus the legacy point");
  assert.equal(new Set(world.features.map((f: any) => f.id)).size, 4);
  const many = world.features.filter((f: any) => f.properties.id === two);
  assert.deepEqual(
    many.map((f: any) => f.geometry.coordinates),
    [[7, 46], [174, -36], [136.9, 35.18]],
  );
  assert.deepEqual(many.map((f: any) => f.id), [`${two}:${L1}`, `${two}:${L2}`, `${two}:${L3}`]);
  assert.deepEqual(many.map((f: any) => f.properties.location_specificity), ["precise", "general", "precise"]);
  const legacy = world.features.find((f: any) => f.properties.id === one);
  assert.equal(legacy.id, `${one}:legacy`, "a POI without stored locations falls back to its point");
  // A viewport over one location admits the POI and renders only that marker.
  const viewport = (await listPoisGeoJson(scoped, {
    ...base,
    isWorldView: false,
    west: 170,
    east: 179,
    south: -40,
    north: -30,
  })) as any;
  assert.deepEqual(viewport.features.map((f: any) => f.id), [`${two}:${L2}`]);
  assert.equal(viewport.total, 1);
  // The entity limit counts POIs, not markers.
  assert.equal(((await listPoisGeoJson(scoped, { ...base, limit: 1 })) as any).features.length, 3);
  const detail = await getPoiById(scoped, two);
  assert.deepEqual(detail.locations.map((l: any) => l.id), [L1, L2, L3]);
  assert.equal(detail.locations[0].is_primary, true);
  assert.deepEqual(detail.locations[1].origins, ["listed_address_geocode"]);
  const legacyDetail = await getPoiById(scoped, one);
  assert.equal(legacyDetail.locations.length, 1);
  assert.equal(legacyDetail.locations[0].kind, "legacy");
  console.log(
    "PASS every known location is a marker with a stable location ID, viewport admission by any location, entity limit, shared detail and legacy fallback; rollback only",
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await db.end();
}
