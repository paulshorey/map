/** Real SQL activation/cache/canonical regression, one existing record, all changes rolled back. */
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { controlState, workerEvidence } from "../../sql/ingestion-control.js";
import { runGeocode, listedQuery, forwardCacheKey } from "./geocode.js";
import { verifyLineage } from "./verify.js";
import { LOCATION_CACHE_VERSION } from "./location.js";
const token = process.argv[2];
if (!token) throw new Error("Owned maintenance token required");
const db = getDb(),
  client = await db.connect(),
  fetchBefore = globalThis.fetch,
  key = process.env.LOCATIONIQ_API_KEY;
let calls = 0;
try {
  await client.query("BEGIN");
  const gate = await controlState(client);
  assert.equal(gate.maintenance, true);
  assert.equal(gate.maintenance_token, token);
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
  const row = (
    await client.query(
      `SELECT rp.* FROM research_pois rp JOIN research_sources s ON s.id=rp.source_id WHERE s.slug='biennale_com' AND rp.name='Venice Biennale'`,
    )
  ).rows[0];
  assert.ok(row?.active_normalization_id);
  await client.query(
    "UPDATE research_pois SET attributes=attributes-'location_enrichment' WHERE id=$1",
    [row.id],
  );
  await client.query("DELETE FROM research_geocode_cache WHERE query_norm=$1", [
    `${LOCATION_CACHE_VERSION}:reverse:${row.lat}:${row.lng}`,
  ]);
  process.env.LOCATIONIQ_API_KEY = "fixture";
  globalThis.fetch = async (url) => {
    assert.ok(
      String(url).startsWith("https://us1.locationiq.com/v1/reverse?"),
      "never call LLM or embedding providers",
    );
    calls++;
    return Response.json({
      lat: String(row.lat),
      lon: String(row.lng),
      licence: "fixture",
      address: {
        country_code: "it",
        city: "Venice",
        state: "Veneto",
        road: "Nearby inferred street",
        house_number: "99",
      },
    });
  };
  const tx = {
    query: (sql: string, ...args: unknown[]) =>
      client.query(
        sql === "BEGIN"
          ? "SAVEPOINT location_fixture"
          : sql === "COMMIT"
            ? "RELEASE SAVEPOINT location_fixture"
            : sql === "ROLLBACK"
              ? "ROLLBACK TO SAVEPOINT location_fixture"
              : sql,
        ...(args as [any]),
      ),
    release: () => {},
  };
  let activations = 0;
  const scoped = {
    query: client.query.bind(client),
    connect: async () => {
      activations++;
      return tx;
    },
  } as unknown as Pool;
  const opts = {
    recordId: row.id,
    geocodeLimit: 2,
    throttleMs: 0,
    dryRun: false,
  };
  // Seed the independent forward lookup; this first assertion exercises reverse only.
  const capturedInput = (
    await client.query(
      "SELECT captured FROM research_poi_observations WHERE id=$1",
      [row.active_observation_id],
    )
  ).rows[0].captured;
  const forwardQuery = listedQuery(row, capturedInput, new Set(["art_fair"]))!;
  await client.query(
    `INSERT INTO research_geocode_cache(query_norm,lat,lng,precision,provider)
    VALUES($1,$2,$3,'point','locationiq') ON CONFLICT(query_norm) DO UPDATE SET lat=EXCLUDED.lat,lng=EXCLUDED.lng`,
    [
      forwardCacheKey(forwardQuery.norm, capturedInput.country_code ?? "IT"),
      row.lat + 0.001,
      row.lng,
    ],
  );
  const first = await runGeocode(scoped, opts);
  assert.equal(first.apiCalls, 1);
  assert.equal(calls, 1);
  const after = (
    await client.query("SELECT * FROM research_pois WHERE id=$1", [row.id])
  ).rows[0];
  assert.deepEqual(
    [after.lat, after.lng, after.coordinate_source],
    [row.lat, row.lng, row.coordinate_source],
  );
  assert.equal(after.address, row.address);
  assert.equal(after.city, "Venice");
  assert.equal(after.region, "Veneto");
  assert.equal(after.country_code, "IT");
  assert.equal(after.active_normalization_id, row.active_normalization_id);
  assert.equal(after.active_observation_id, row.active_observation_id);
  const cp = (
    await client.query("SELECT * FROM canonical_pois WHERE id=$1", [
      row.canonical_poi_id,
    ])
  ).rows[0];
  assert.equal(cp.attributes.country_code, "IT");
  assert.equal(cp.attributes.region, "Veneto");
  assert.equal(cp.attributes.city, "Venice");
  assert.equal(cp.address, row.address);
  assert.equal(cp.field_provenance.address.derivation, "source");
  const evidence = cp.attributes.coordinate_evidence;
  assert.deepEqual(
    [evidence.source_coordinates.lat, evidence.source_coordinates.lng],
    [row.lat, row.lng],
  );
  assert.deepEqual(
    [evidence.inferred_coordinates.lat, evidence.inferred_coordinates.lng],
    [row.lat + 0.001, row.lng],
  );
  assert.equal(
    evidence.inferred_coordinates.geocode_id,
    after.active_geocode_id,
  );
  assert.equal(
    evidence.inferred_coordinates.normalization_id,
    row.active_normalization_id,
  );
  const second = await runGeocode(scoped, opts);
  assert.equal(second.selected, 0);
  assert.equal(calls, 1);
  assert.equal(await verifyLineage(scoped), 0);
  // Forward and reverse are two provider operations but ONE fenced activation/commit.
  const captured = (
    await client.query(
      "SELECT captured FROM research_poi_observations WHERE id=$1",
      [row.active_observation_id],
    )
  ).rows[0].captured;
  const q = listedQuery(row, captured, new Set(["art_fair"]))!;
  await client.query(
    "DELETE FROM research_geocode_cache WHERE query_norm=ANY($1::text[])",
    [
      [
        forwardCacheKey(q.norm, captured.country_code ?? "IT"),
        `${LOCATION_CACHE_VERSION}:reverse:${row.lat}:${row.lng}`,
      ],
    ],
  );
  await client.query(
    "UPDATE research_pois SET lat=NULL,lng=NULL,coordinate_source=NULL,active_geocode_id=NULL,attributes=attributes-'location_enrichment' WHERE id=$1",
    [row.id],
  );
  const before = activations;
  let forwardCalls = 0,
    reverseCalls = 0;
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/search")) {
      forwardCalls++;
      return Response.json([
        {
          lat: String(row.lat),
          lon: String(row.lng),
          class: "place",
          type: "attraction",
          // Real responses carry addressdetails; an unnamed result would need city verification.
          address: { city: "Venice", state: "Veneto", country_code: "it" },
        },
      ]);
    }
    assert.ok(u.pathname.endsWith("/reverse"));
    reverseCalls++;
    assert.equal(
      (
        await client.query("SELECT lat FROM research_pois WHERE id=$1", [
          row.id,
        ])
      ).rows[0].lat,
      null,
      "point must not activate before reverse enrichment finishes",
    );
    return Response.json({
      lat: String(row.lat),
      lon: String(row.lng),
      address: { country_code: "it", city: "Venice", state: "Veneto" },
    });
  };
  const forward = await runGeocode(scoped, { ...opts, geocodeLimit: 2 });
  assert.equal(forward.apiCalls, 2);
  assert.equal(forwardCalls, 1);
  assert.equal(reverseCalls, 1);
  assert.equal(
    activations - before,
    1,
    "one activation completes one task after both lookups",
  );
  const restored = (
    await client.query("SELECT * FROM research_pois_current WHERE id=$1", [
      row.id,
    ])
  ).rows[0];
  assert.equal(restored.lat, row.lat);
  assert.equal(restored.country_code, "IT");
  assert.equal(restored.region, "Veneto");
  assert.equal(restored.address, row.address);
  assert.equal(await verifyLineage(scoped), 0);
  console.log(
    "PASS source coordinates/address preserved, inferred region/canonical provenance retained, cache skips second lookup, immutable IDs and lineage preserved; rollback only",
  );
} finally {
  globalThis.fetch = fetchBefore;
  if (key === undefined) delete process.env.LOCATIONIQ_API_KEY;
  else process.env.LOCATIONIQ_API_KEY = key;
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
  await db.end();
}
