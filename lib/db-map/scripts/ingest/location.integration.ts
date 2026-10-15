/** Real SQL activation/cache/canonical regression, one existing record, all changes rolled back. */
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { controlState, workerEvidence } from "../../sql/ingestion-control.js";
import { runGeocode } from "./geocode.js";
import { verifyLineage } from "./verify.js";
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
    `location-v1:reverse:${row.lat}:${row.lng}`,
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
  const scoped = {
    query: client.query.bind(client),
    connect: async () => tx,
  } as unknown as Pool;
  const opts = {
    recordId: row.id,
    geocodeLimit: 1,
    throttleMs: 0,
    dryRun: false,
  };
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
  const second = await runGeocode(scoped, opts);
  assert.equal(second.selected, 0);
  assert.equal(calls, 1);
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
