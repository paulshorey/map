/** One linked record, no providers; all real SQL mutations roll back. Requires owned quiescent maintenance. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { controlState, workerEvidence } from "../../sql/ingestion-control.js";
import { writeEmbedding } from "./embed.js";
import { writeRowCoords } from "./geocode.js";
const token = process.argv[2];
if (!token)
  throw new Error("Pass the owned maintenance token as the only argument");
const db = getDb(),
  client = await db.connect();
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
    (
      await client.query(
        "SELECT pg_try_advisory_xact_lock(91832,1) AS acquired",
      )
    ).rows[0].acquired,
    true,
  );
  const row = (
    await client.query(`SELECT rp.id,rp.lat,rp.lng,rp.content_embedding,rp.canonical_poi_id FROM research_pois rp
  JOIN research_sources s ON s.id=rp.source_id WHERE s.slug='thedyrt' AND rp.retired_at IS NULL AND rp.active_embedding_id IS NOT NULL
  AND rp.canonical_poi_id IS NOT NULL ORDER BY rp.source_record_id LIMIT 1`)
  ).rows[0];
  assert.ok(row);
  // Real nested transactions use savepoints so the outer rollback restores every artifact/pointer/build.
  const tx = {
    query: (sql: string, ...args: unknown[]) =>
      client.query(
        sql === "BEGIN"
          ? "SAVEPOINT artifact_fixture"
          : sql === "COMMIT"
            ? "RELEASE SAVEPOINT artifact_fixture"
            : sql === "ROLLBACK"
              ? "ROLLBACK TO SAVEPOINT artifact_fixture"
              : sql,
        ...(args as [any]),
      ),
    release: () => {},
  };
  const scoped = {
    query: client.query.bind(client),
    connect: async () => tx,
  } as unknown as Pool;
  await writeEmbedding(
    scoped,
    row.id,
    "rollback-only artifact fixture " + randomUUID(),
    row.content_embedding,
  );
  const queryNorm = "rollback-only " + randomUUID();
  await client.query(
    "INSERT INTO research_geocode_cache(query_norm,lat,lng,precision,provider) VALUES($1,$2,$3,'city','locationiq')",
    [queryNorm, row.lat, row.lng],
  );
  await writeRowCoords(scoped, row.id, row.lat, row.lng, "city", queryNorm);
  const result = (
    await client.query(
      `SELECT rp.active_embedding_id,rp.active_geocode_id,bi.embedding_id,bi.geocode_id FROM research_pois rp
  JOIN canonical_pois cp ON cp.id=rp.canonical_poi_id JOIN canonical_poi_build_inputs bi ON bi.build_id=cp.active_build_id AND bi.research_poi_id=rp.id
  WHERE rp.id=$1`,
      [row.id],
    )
  ).rows[0];
  assert.ok(result);
  assert.equal(result.embedding_id, result.active_embedding_id);
  assert.equal(result.geocode_id, result.active_geocode_id);
  console.log(
    "PASS linked embedding/geocode activation atomically refreshes canonical build inputs; all writes rolled back",
  );
} finally {
  await client.query("ROLLBACK").catch(() => undefined);
  client.release();
  await db.end();
}
