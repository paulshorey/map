/**
 * A managed match asks the model with no transaction open, then applies the answer under
 * the canonical lock. Runs against the isolated location-assessment test database only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg, { type Pool } from "pg";
import { runMatch } from "./match.js";
import { withAttemptContext, type Execution } from "./execution.js";
import { deriveForwardPrecision } from "../../lib/ingestion/geocode-precision.js";
import {
  LOCATION_GEOCODER_VERSION,
  LOCATION_QUERY_VERSION,
  LOCATION_VERSION,
} from "./location.js";
import { recordLocations, writeRecordLocations } from "./record-locations.js";

const connection = process.env.MAP_LOCATION_ASSESSMENT_TEST_URL;
test(
  "managed match makes its model calls outside the transaction and applies them inside",
  { skip: !connection },
  async () => {
    const url = new URL(connection!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/map_location_assessment_test");
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.FIREWORKS_API_KEY;
    process.env.FIREWORKS_API_KEY = "fixture";
    // Stage code owns its transactions; savepoints keep the whole fixture reversible.
    let open = 0,
      rollbacks = 0;
    const tx = {
      query(sql: string, ...args: any[]) {
        if (sql === "BEGIN") open++;
        if (sql === "COMMIT" || sql === "ROLLBACK") open--;
        if (sql === "ROLLBACK") rollbacks++;
        return client.query(
          sql === "BEGIN"
            ? "SAVEPOINT stage_fixture"
            : sql === "COMMIT"
              ? "RELEASE SAVEPOINT stage_fixture"
              : sql === "ROLLBACK"
                ? "ROLLBACK TO SAVEPOINT stage_fixture"
                : sql,
          ...(args as [any]),
        );
      },
      release() {},
    };
    const db = {
      query: client.query.bind(client),
      connect: async () => tx,
    } as unknown as Pool;
    const options = (id: string, noLlm: boolean) => ({
      recordId: id,
      limit: 1,
      dryRun: false,
      noLlm,
      recluster: false,
      gcOrphans: false,
      consolidate: false,
      consolidateOnly: false,
      // Never auto-merge or auto-reject on score: the pair must be adjudicated.
      tHigh: 2,
      tLow: -1,
    });
    try {
      await client.query("BEGIN");
      const source = (
        await client.query(
          "INSERT INTO research_sources(slug,name) VALUES('match_llm_fixture','Match LLM fixture') RETURNING id",
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO canonical_categories(slug,display_name,is_active) VALUES('campground','Campground',true) ON CONFLICT(slug) DO UPDATE SET is_active=true",
      );
      async function seed(
        name: string,
        lat: number,
        website: string,
        description: string,
      ) {
        const id = randomUUID(),
          observation = randomUUID(),
          normalization = randomUUID(),
          geocode = randomUUID(),
          lng = -97;
        const point = {
          lat,
          lng,
          kind: "source",
          origin: "source_coordinates",
          precision: "point",
          label: null,
          query: null,
        };
        const validation = {
          version: LOCATION_VERSION,
          fields: { country_code: "US", city: "Austin", region: null, address: null },
          normalization_id: normalization,
          point: { lat, lng },
          coordinate_evidence: {
            source_coordinates: point,
            inferred_coordinates: {
              ...point,
              kind: "inferred",
              origin: "listed_address_geocode",
              query: "Venue, Austin, US",
              precision_evidence: deriveForwardPrecision({}),
            },
          },
          forward: {
            query_version: LOCATION_QUERY_VERSION,
            country_filter: "US",
            result: { ...point, country_code: "US" },
          },
          listed: { country_code: "US", city: "Austin" },
          reverse: null,
          warnings: [],
        };
        await client.query(
          `INSERT INTO research_pois(id,source_id,source_record_id,name,name_normalized,raw,lat,lng,coordinate_source,coordinate_precision,
        category_slugs,is_poi,normalization_state,country_code,city,website,description,attributes)
        VALUES($1::uuid,$2,$1::text,$3,$3,'{}',$4,$5,'source','point',ARRAY['campground'],true,'active','US','Austin',$6,$7,$8)`,
          [id, source, name, lat, lng, website, description, { location_enrichment: validation }],
        );
        await client.query(
          "INSERT INTO research_poi_observations(id,research_poi_id,raw_content_hash,raw,captured) VALUES($1::uuid,$2,$1::text,'{}',$3)",
          [observation, id, { name, lat, lng, city: "Austin", country_code: "US" }],
        );
        await client.query(
          `INSERT INTO research_poi_normalizations(id,research_poi_id,observation_id,input_hash,normalizer_version,status,is_poi)
        VALUES($1::uuid,$2,$3,$1::text,'fixture','accepted',true)`,
          [normalization, id, observation],
        );
        await client.query(
          `INSERT INTO research_poi_geocodes(id,normalization_id,input_hash,provider,provider_version,lat,lng,precision,status,validation)
        VALUES($1::uuid,$2,$1::text,'fixture',$3,$4,$5,'point','resolved',$6)`,
          [geocode, normalization, LOCATION_GEOCODER_VERSION, lat, lng, validation],
        );
        await writeRecordLocations(
          client as never,
          { research_poi_id: id, geocode_id: geocode, normalization_id: normalization },
          recordLocations({
            source: validation.coordinate_evidence.source_coordinates,
            inferred: validation.coordinate_evidence.inferred_coordinates,
            basis: "address",
            fallbackFrom: null,
            rejected: null,
          }),
        );
        await client.query(
          "UPDATE research_pois SET active_observation_id=$2,active_normalization_id=$3,active_geocode_id=$4 WHERE id=$1",
          [id, observation, normalization, geocode],
        );
        return id;
      }

      // An anchor (it has a website), published without any model call.
      globalThis.fetch = async () => {
        throw new Error("No provider call is expected for the anchor");
      };
      const anchor = await seed(
        "Pine Lake Campground",
        30,
        "https://pinelake.example/",
        "Lakeside sites under tall pines.",
      );
      assert.equal(
        (await runMatch(db, options(anchor, true), { requested: false, count: 0 })).created,
        1,
      );
      const canonical = (
        await client.query("SELECT canonical_poi_id FROM research_pois WHERE id=$1", [anchor])
      ).rows[0].canonical_poi_id;

      // A second listing 20 m away with a similar name: only the model can decide.
      const second = await seed(
        "Pine Lake Campground Resort",
        30.0002,
        "https://pinelakeresort.example/",
        "Family resort with cabins and a boat ramp.",
      );
      const asked: string[] = [];
      globalThis.fetch = async (_input, init) => {
        assert.equal(open, 0, "a model request must not start inside a transaction");
        const body = JSON.parse(String(init!.body));
        const system = String(body.messages[0].content);
        const fusion = system.startsWith("Combine multiple source descriptions");
        asked.push(fusion ? "description_fusion" : "match");
        // Yield, so a transaction opened during the request would be observed.
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(open, 0, "no transaction may open while the request is in flight");
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: fusion
                  ? "Lakeside campground and family resort with cabins."
                  : JSON.stringify({ same_place: true, reason: "Same lake, same grounds." }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
      };
      const execution = {
        id: randomUUID(),
        stopped: false,
        abortController: new AbortController(),
        check() {},
        recordProviderLifecycle() {},
        recordProviderOutputFailure() {},
        // The provider ledger is not under test.
        db: { query: async () => ({ rows: [] }) },
      } as unknown as Execution;
      rollbacks = 0;
      const stats = await withAttemptContext(
        { runId: randomUUID(), attemptId: randomUUID(), execution, stage: "match" },
        () => runMatch(db, options(second, false), { requested: false, count: 0 }),
      );
      assert.equal(open, 0);
      assert.equal(stats.merged, 1);
      assert.equal(stats.llm, 1);
      assert.deepEqual(asked, ["match", "description_fusion"], "each question is asked once");
      assert.equal(rollbacks, 0, "both answers were ready before the lock was taken");
      assert.equal(
        (await client.query("SELECT canonical_poi_id FROM research_pois WHERE id=$1", [second]))
          .rows[0].canonical_poi_id,
        canonical,
      );
      const published = (
        await client.query("SELECT description, status FROM canonical_pois WHERE id=$1", [canonical])
      ).rows[0];
      assert.equal(published.description, "Lakeside campground and family resort with cabins.");
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM research_canonical_memberships WHERE canonical_poi_id=$1 AND active",
            [canonical],
          )
        ).rows[0].n,
        2,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = originalKey;
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);
