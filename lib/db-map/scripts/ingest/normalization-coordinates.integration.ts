/** One RIDB preflight record; real activation SQL, rollback only, no providers. */
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { controlState, workerEvidence } from "../../sql/ingestion-control.js";
import { findReusableNormalizations, runHybridNormalize } from "./normalize/runner.js";
import { verifyLineage } from "./verify.js";

const token = process.argv[2];
if (!token) throw new Error("Pass the owned maintenance token");
const db = getDb(), client = await db.connect();
const fetchBefore = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Provider calls forbidden in rollback integration"); };
try {
  await client.query("BEGIN");
  const gate = await controlState(client);
  assert.equal(gate.maintenance_token, token);
  assert.equal(gate.maintenance, true);
  const workers = await workerEvidence(client);
  assert.equal(workers.workers.length + workers.sourceLocks.length + workers.admitted.length, 0);
  assert.equal((await client.query("SELECT pg_try_advisory_xact_lock(91832,1) acquired")).rows[0].acquired, true);
  const original = (await client.query(`SELECT rp.* FROM research_pois rp JOIN research_sources s ON s.id=rp.source_id
    JOIN research_poi_observations o ON o.id=rp.active_observation_id
    WHERE s.slug='ridb' AND rp.source_record_id='10367801' AND (o.captured->>'lat')::float=0 AND (o.captured->>'lng')::float=0`)).rows[0];
  assert.ok(original?.active_normalization_id, "requires the bounded RIDB zero-coordinate preflight artifact");
  await client.query("UPDATE research_pois SET lat=0,lng=0,coordinate_source=NULL,active_geocode_id=NULL WHERE id=$1", [original.id]);
  const tx = {
    query: (sql: string, ...args: unknown[]) => client.query(
      sql === "BEGIN" ? "SAVEPOINT coordinate_fixture" : sql === "COMMIT" ? "RELEASE SAVEPOINT coordinate_fixture" :
        sql === "ROLLBACK" ? "ROLLBACK TO SAVEPOINT coordinate_fixture" : sql, ...(args as [any])),
    release: () => {},
  };
  const scoped = { query: client.query.bind(client), connect: async () => tx } as unknown as Pool;
  const opts = { recordId: original.id, noLlm: false, shadow: false, reprocess: false, retryFailed: false };
  assert.equal((await findReusableNormalizations(scoped, opts, [original.id])).length, 0,
    "bad projected coordinates must not bypass activation through the active cache");
  const result = await runHybridNormalize(scoped, opts);
  assert.equal(result.cacheHits, 1);
  assert.equal(result.llmRequests, 0);
  const after = (await client.query("SELECT * FROM research_pois WHERE id=$1", [original.id])).rows[0];
  assert.equal(after.lat, null);
  assert.equal(after.lng, null);
  assert.equal(after.canonical_poi_id, null, "coordinate changes require matching again");
  assert.equal(after.active_normalization_id, original.active_normalization_id);
  assert.equal(after.active_observation_id, original.active_observation_id);
  assert.equal((await client.query("SELECT count(*)::int n FROM research_canonical_memberships WHERE research_poi_id=$1 AND active", [original.id])).rows[0].n, 0);
  assert.equal(await verifyLineage(scoped), 0);
  console.log("PASS cached activation clears invalid coordinates, retires stale membership, retains immutable artifacts; zero provider calls, all writes rolled back");
} finally {
  globalThis.fetch = fetchBefore;
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
  await db.end();
}
