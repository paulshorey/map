/** One temporary source/record; transaction always rolls back. No provider calls. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "../../lib/db/postgres.js";
import { observeRecord } from "./orchestrator.js";
import { rawContentHash } from "./hash.js";
import { mapGenericRecord } from "./extractors/generic.js";
import { mapFestivalLocation } from "./extractors/thatfestivalsite.js";
import { resolveSourceFile } from "./source-file.js";
import { controlState, workerEvidence } from "../../sql/ingestion-control.js";

const token = process.argv[2];
if (!token) throw new Error("Owned maintenance token required");
const db = getDb();
const client = await db.connect();
try {
  await client.query("BEGIN");
  await client.query("SET LOCAL statement_timeout='10s'");
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
  const source = (
    await client.query(
      "INSERT INTO research_sources(slug,name) VALUES($1,'mapping fixture') RETURNING id",
      [`mapping_${randomUUID()}`],
    )
  ).rows[0];
  const resolved = await resolveSourceFile(
    "data/poi/music-festivals/directories/thatfestivalsite_festivals.json",
    "music_festival",
  );
  const ctx = {
    resolved,
    sourceId: source.id,
    fileVersionId: null,
  } as unknown as Parameters<typeof observeRecord>[1];
  const raw = {
    id: "fixture",
    name: "Festival",
    city: "Australia",
    country: "Australia",
    latitude: -33.8941187,
    longitude: 151.2242143,
  };
  const hash = rawContentHash(raw);
  const v2 = await observeRecord(
    client,
    ctx,
    mapGenericRecord(raw)!,
    true,
    hash,
  );
  const v3 = await observeRecord(
    client,
    ctx,
    mapFestivalLocation(raw)!,
    true,
    hash,
  );
  assert.equal(v2.state, "inserted");
  assert.equal(v3.state, "changed");
  assert.equal(v3.poiId, v2.poiId);
  assert.notEqual(v3.observationId, v2.observationId);
  const { rows } = await client.query(
    "SELECT id,raw_content_hash,raw,captured,capture_hash FROM research_poi_observations WHERE research_poi_id=$1 ORDER BY first_seen_at,id",
    [v2.poiId],
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.raw_content_hash === hash.hash));
  assert.deepEqual(rows[0].raw, rows[1].raw);
  const old = rows.find((r) => r.id === v2.observationId)!;
  const next = rows.find((r) => r.id === v3.observationId)!;
  assert.equal(old.captured.city, "Australia");
  assert.equal(next.captured.city, null);
  assert.equal(
    next.captured.attributes.source_location_hints.country,
    "Australia",
  );
  assert.notEqual(old.capture_hash, next.capture_hash);
  const projection = (
    await client.query(
      "SELECT city,country_code,lat,lng,active_observation_id,normalization_state FROM research_pois WHERE id=$1",
      [v3.poiId],
    )
  ).rows[0];
  assert.equal(projection.city, null);
  assert.equal(projection.country_code, null);
  assert.equal(projection.active_observation_id, v3.observationId);
  assert.deepEqual(
    [projection.lat, projection.lng],
    [raw.latitude, raw.longitude],
  );
  const repeated = await observeRecord(
    client,
    ctx,
    mapFestivalLocation(raw)!,
    true,
    hash,
  );
  assert.equal(repeated.state, "unchanged");
  assert.equal(repeated.observationId, v3.observationId);
  const changedHint = await observeRecord(
    client,
    ctx,
    mapFestivalLocation(raw)!,
    false,
    hash,
  );
  assert.equal(changedHint.state, "changed");
  assert.notEqual(changedHint.observationId, v3.observationId);
  console.log(
    "PASS unchanged raw + changed capture activates new immutable observation; repeated mapping reuses it; POI hint changes invalidate; raw SHA/points/previous captures retained. Rollback only.",
  );
} finally {
  await client.query("ROLLBACK");
  client.release();
  await closeDb();
}
