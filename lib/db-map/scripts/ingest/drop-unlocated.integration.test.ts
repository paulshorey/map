/**
 * A record that cannot be located is dropped inside its geocode task's completion, so its
 * file can still finish. Runs against the isolated location-assessment test database only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import {
  RECORD_STAGES,
  UNLOCATED_DROPPED,
  finishTask,
  unfinishedTaskCounts,
  type TaskClaim,
} from "../../sql/ingestion-tasks.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";

const connection = process.env.MAP_LOCATION_ASSESSMENT_TEST_URL;
test(
  "an unlocatable record is retired, its later stages skipped, and its file left able to complete",
  { skip: !connection },
  async () => {
    const url = new URL(connection!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/map_location_assessment_test");
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    const asClient = client as unknown as PoolClient;
    try {
      await client.query("BEGIN");
      const source = (
        await client.query(
          "INSERT INTO research_sources(slug,name) VALUES('drop_fixture','Drop fixture') RETURNING id",
        )
      ).rows[0].id;
      const file = (
        await client.query(
          "INSERT INTO research_source_files(source_id,logical_path,category_slug,format,extractor_version) VALUES($1,'data/poi/drop.json','campground','json','fixture') RETURNING id",
          [source],
        )
      ).rows[0].id;
      const version = (
        await client.query(
          "INSERT INTO research_source_file_versions(source_file_id,file_sha256,byte_size,extractor_version) VALUES($1,'fixture',1,'fixture') RETURNING id",
          [file],
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO canonical_categories(slug,display_name,is_active) VALUES('campground','Campground',true) ON CONFLICT(slug) DO UPDATE SET is_active=true",
      );
      const run = (
        await client.query(
          "INSERT INTO research_ingest_runs(source_file_version_id,source_id,category_slug) VALUES($1,$2,'campground') RETURNING id",
          [version, source],
        )
      ).rows[0].id;
      const execution = (
        await client.query(
          "INSERT INTO research_ingest_executions(run_id,host,pid,options) VALUES($1,'fixture',1,'{}') RETURNING id",
          [run],
        )
      ).rows[0].id;
      // One record with no coordinates: normalized, then claimed by the geocode stage.
      const id = randomUUID(),
        observation = randomUUID();
      await client.query(
        `INSERT INTO research_pois(id,source_id,source_record_id,name,name_normalized,raw,category_slugs,is_poi,normalization_state)
        VALUES($1::uuid,$2,$1::text,'East Africa Art Biennale','east africa art biennale','{}',ARRAY['campground'],true,'active')`,
        [id, source],
      );
      await client.query(
        "INSERT INTO research_poi_observations(id,research_poi_id,raw_content_hash,raw,captured) VALUES($1::uuid,$2,$1::text,'{}','{}')",
        [observation, id],
      );
      await client.query("UPDATE research_pois SET active_observation_id=$2 WHERE id=$1", [
        id,
        observation,
      ]);
      await client.query(
        "INSERT INTO research_ingest_run_items(run_id,source_record_id,source_ordinal,research_poi_id,observation_id) VALUES($1,$2::text,0,$2::uuid,$3)",
        [run, id, observation],
      );
      const token = randomUUID();
      for (const [rank, stage] of RECORD_STAGES.entries())
        await client.query(
          `INSERT INTO research_ingest_tasks(run_id,source_record_id,stage,rank,state,claim_token,execution_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            run,
            id,
            stage,
            rank,
            stage === "normalize" ? "succeeded" : stage === "geocode" ? "running" : "pending",
            stage === "geocode" ? token : null,
            stage === "geocode" ? execution : null,
          ],
        );
      const attempt = (
        await client.query(
          "INSERT INTO research_ingest_attempts(run_id,execution_id,stage,target_key,status) VALUES($1,$2,'geocode',$3,'running') RETURNING id",
          [run, execution, id],
        )
      ).rows[0].id;
      const claim: TaskClaim = {
        run_id: run,
        source_record_id: id,
        research_poi_id: id,
        observation_id: observation,
        stage: "geocode",
        rank: RECORD_STAGES.indexOf("geocode"),
        claim_token: token,
        execution_id: execution,
      };
      // An earlier attempt had left it blocked, waiting for a decision.
      await client.query(
        `INSERT INTO research_ingest_issues(run_id,source_record_id,stage,code,scope,severity,message,evidence,retryable)
        VALUES($1,$2,'geocode','record_blocked','record','blocking','geocode_result','{}',false)`,
        [run, id],
      );

      await finishTask(asClient, claim, attempt, {
        status: "skipped",
        reason: UNLOCATED_DROPPED,
        unlocated: "geocode_result",
      });

      const tasks = (
        await client.query(
          "SELECT stage,state,output->>'reason' AS reason FROM research_ingest_tasks WHERE run_id=$1 ORDER BY rank",
          [run],
        )
      ).rows;
      assert.deepEqual(
        tasks.map((t) => [t.stage, t.state]),
        RECORD_STAGES.map((stage) => [stage, stage === "normalize" ? "succeeded" : "skipped"]),
      );
      assert.ok(tasks.slice(1).every((t) => t.reason === UNLOCATED_DROPPED));
      assert.ok(
        (await client.query("SELECT retired_at FROM research_pois WHERE id=$1", [id])).rows[0]
          .retired_at,
      );
      // The raw observation is kept.
      assert.equal(
        (await client.query("SELECT count(*)::int n FROM research_poi_observations WHERE id=$1", [observation])).rows[0].n,
        1,
      );
      const verification = (
        await client.query(
          "SELECT outcome,output,pipeline_versions FROM research_ingest_record_verifications WHERE run_id=$1 AND source_record_id=$2",
          [run, id],
        )
      ).rows[0];
      assert.equal(verification.outcome, "operator_excluded");
      assert.equal(verification.output.reason, UNLOCATED_DROPPED);
      assert.deepEqual(verification.pipeline_versions, PIPELINE_VERSIONS);
      const issues = (
        await client.query(
          "SELECT code,status FROM research_ingest_issues WHERE run_id=$1 ORDER BY code",
          [run],
        )
      ).rows;
      assert.deepEqual(issues, [
        { code: "record_blocked", status: "excluded" },
        { code: UNLOCATED_DROPPED, status: "excluded" },
      ]);
      // Nothing is left for the scheduler to wait on: the run can go on to verify.
      assert.deepEqual(
        await unfinishedTaskCounts(client as unknown as Pool, run, 0, RECORD_STAGES.length - 1),
        [],
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int n FROM research_ingest_tasks WHERE run_id=$1 AND state='quarantined'",
            [run],
          )
        ).rows[0].n,
        0,
        "no quarantined task, so the run does not end partial",
      );
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);
