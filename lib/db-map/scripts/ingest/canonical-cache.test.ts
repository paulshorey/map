/** Run with an explicitly named disposable PostgreSQL database; never DB_MAP_URL. */
import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import type { Pool } from "pg";
import { seedTasks, RECORD_STAGES } from "../../sql/ingestion-tasks.js";
import { pendingStageItems, prepareStageQueue } from "./work-queue.js";
import {
  PIPELINE_VERSIONS,
  resumePipelineUpgrade,
} from "./pipeline-versions.js";
import {
  LOCATION_VERSION,
  LOCATION_QUERY_VERSION,
  LOCATION_GEOCODER_VERSION,
} from "./location.js";
import type { Execution } from "./execution.js";

const connection = process.env.MAP_CANONICAL_TEST_URL;
test(
  "old canonical builds requeue downstream tasks and refuse both caches; refreshed builds resume",
  { skip: !connection },
  async () => {
    const url = new URL(connection!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/map_canonical_cache_test");
    assert.equal(url.search, "");
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      await client.query(`
      CREATE TEMP TABLE research_ingest_runs(id text PRIMARY KEY,current_stage text,counters jsonb DEFAULT '{}');
      CREATE TEMP TABLE research_ingest_executions(id text PRIMARY KEY,scheduler_version int);
      CREATE TEMP TABLE research_ingest_run_items(run_id text,source_record_id text,research_poi_id text,observation_id text,source_ordinal int);
      CREATE TEMP TABLE research_ingest_attempts(id text,run_id text,target_key text,stage text,status text,output jsonb,started_at timestamptz DEFAULT now());
      CREATE TEMP TABLE research_pois(id text,active_observation_id text,active_normalization_id text,active_geocode_id text,active_embedding_id text,canonical_poi_id text,normalization_state text,retired_at timestamptz,is_poi boolean,lat real,lng real,attributes jsonb,content_embedding text);
      CREATE TEMP TABLE research_poi_normalizations(id text,observation_id text);
      CREATE TEMP TABLE research_poi_geocodes(id text,normalization_id text,provider_version text,validation jsonb);
      CREATE TEMP TABLE research_poi_embeddings(id text,normalization_id text);
      CREATE TEMP TABLE research_canonical_memberships(id text,research_poi_id text,normalization_id text,canonical_poi_id text,active boolean);
      CREATE TEMP TABLE canonical_pois(id text,active_build_id text,status text);
      CREATE TEMP TABLE canonical_poi_builds(id text,builder_version text);
      CREATE TEMP TABLE canonical_poi_build_inputs(build_id text,membership_id text,normalization_id text,embedding_id text,geocode_id text);
      CREATE TEMP TABLE research_ingest_tasks(run_id text,source_record_id text,stage text,rank int,input jsonb,state text,output jsonb,claim_token text,execution_id text,updated_at timestamptz,finished_at timestamptz,PRIMARY KEY(run_id,source_record_id,stage));
      CREATE TEMP TABLE research_ingest_issues(run_id text,source_record_id text,status text);
      INSERT INTO research_ingest_runs(id) VALUES('run');
      INSERT INTO research_ingest_executions(id) VALUES('execution');
      INSERT INTO research_ingest_run_items VALUES('run','record','poi','observation',1);
      INSERT INTO research_poi_normalizations VALUES('normalization','observation');
      INSERT INTO research_poi_embeddings VALUES('embedding','normalization');
      INSERT INTO research_canonical_memberships VALUES('membership','poi','normalization','canonical',true);
      INSERT INTO canonical_pois VALUES('canonical','build','published');
      INSERT INTO canonical_poi_builds VALUES('build','canonical-build-v4');
      INSERT INTO canonical_poi_build_inputs VALUES('build','membership','normalization','embedding','geocode');
    `);
      const coordinate_evidence = {
        source_coordinates: {
          lat: 30,
          lng: -97,
          kind: "source",
          origin: "source_coordinates",
          precision: "point",
        },
        inferred_coordinates: null,
      };
      await client.query(
        "INSERT INTO research_poi_geocodes VALUES('geocode','normalization',$1,$2)",
        [LOCATION_GEOCODER_VERSION, { coordinate_evidence }],
      );
      await client.query(
        `INSERT INTO research_pois VALUES('poi','observation','normalization','geocode','embedding','canonical','active',NULL,true,30,-97,$1,'vector')`,
        [
          {
            location_enrichment: {
              version: LOCATION_VERSION,
              normalization_id: "normalization",
              point: { lat: 30, lng: -97 },
              forward: { query_version: LOCATION_QUERY_VERSION },
              coordinate_evidence,
            },
          },
        ],
      );
      const output = {
        status: "succeeded",
        normalization_id: "normalization",
        geocode_id: "geocode",
        embedding_id: "embedding",
        canonical_id: "canonical",
        build_id: "build",
      };
      for (const [rank, stage] of RECORD_STAGES.entries()) {
        await client.query(
          "INSERT INTO research_ingest_tasks(run_id,source_record_id,stage,rank,state,output) VALUES('run','record',$1,$2,'succeeded',$3)",
          [stage, rank, output],
        );
        await client.query(
          "INSERT INTO research_ingest_attempts(id,run_id,target_key,stage,status,output) VALUES($1,'run','record',$1,'succeeded',$2)",
          [stage, output],
        );
      }
      const db = { query: client.query.bind(client) } as unknown as Pool;
      await seedTasks(db, "run", "execution");
      const states = (
        await client.query(
          "SELECT stage,state FROM research_ingest_tasks ORDER BY rank",
        )
      ).rows;
      assert.deepEqual(
        states.map((r) => r.state),
        [
          "succeeded",
          "succeeded",
          "succeeded",
          "pending",
          "pending",
          "pending",
        ],
      );
      let reused = 0;
      const ex = {
        runId: "run",
        check() {},
        stopped: false,
        reuseBatch: async (_stage: string, values: unknown[]) => {
          reused += values.length;
          return values.length;
        },
      } as unknown as Execution;
      for (const stage of ["match", "canonical", "verify"]) {
        assert.equal((await pendingStageItems(db, "run", stage)).length, 1);
        const queue = await prepareStageQueue(db, ex, stage, 1, {} as any);
        assert.equal(queue.reused, 0);
        assert.equal(queue.pending, 1);
      }
      assert.equal(
        reused,
        0,
        "stale builds must never be accepted by batch reuse",
      );
      assert.equal((await pendingStageItems(db, "run", "geocode")).length, 0);
      assert.equal((await pendingStageItems(db, "run", "embed")).length, 0);
      const old = {
        ...PIPELINE_VERSIONS,
        geocode: "locationiq-location-v3",
        canonicalBuilder: "canonical-build-v4",
      };
      assert.deepEqual(resumePipelineUpgrade(old)?.to, PIPELINE_VERSIONS);
      // Simulate publication by the existing match-stage rebuild path, retaining all input IDs.
      await client.query("UPDATE canonical_poi_builds SET builder_version=$1", [
        PIPELINE_VERSIONS.canonicalBuilder,
      ]);
      await client.query(
        "UPDATE research_ingest_tasks SET state='succeeded',output=$1",
        [output],
      );
      await seedTasks(db, "run", "execution");
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int n FROM research_ingest_tasks WHERE state='pending'",
          )
        ).rows[0].n,
        0,
      );
      for (const stage of ["match", "canonical", "verify"])
        assert.equal((await pendingStageItems(db, "run", stage)).length, 0);
      // A new run with no successful attempts accepts the current active build in batches.
      await client.query(
        "DELETE FROM research_ingest_attempts WHERE stage IN ('match','canonical','verify')",
      );
      for (const stage of ["match", "canonical", "verify"]) {
        const queue = await prepareStageQueue(db, ex, stage, 1, {} as any);
        assert.equal(queue.reused, 1);
      }
      assert.equal(reused, 3);
    } finally {
      await client.end();
    }
  },
);
