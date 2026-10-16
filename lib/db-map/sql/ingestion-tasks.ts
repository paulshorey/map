import { locationReadySql } from "../scripts/ingest/location.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AttemptResult } from "../scripts/ingest/execution.js";
import { PIPELINE_VERSIONS } from "../scripts/ingest/pipeline-versions.js";
export const RECORD_STAGES = [
  "normalize",
  "geocode",
  "embed",
  "match",
  "canonical",
  "verify",
] as const;
export type RecordStage = (typeof RECORD_STAGES)[number];
export interface TaskClaim {
  run_id: string;
  source_record_id: string;
  research_poi_id: string;
  observation_id: string;
  stage: RecordStage;
  rank: number;
  claim_token: string;
  execution_id: string;
}
const VALID = `rp.id IS NOT NULL AND rp.retired_at IS NULL AND rp.active_observation_id=i.observation_id`;
const READY = `n.id IS NOT NULL AND n.observation_id=i.observation_id AND rp.normalization_state IN ('active','degraded','rejected')`;
export async function seedTasks(
  db: Pool,
  run: string,
  execution: string,
  fromRank = 0,
) {
  await db.query(
    `INSERT INTO research_ingest_tasks(run_id,source_record_id,stage,rank,input,state,output)
    SELECT i.run_id,i.source_record_id,s.stage,r.rank,
      jsonb_build_object('research_poi_id',i.research_poi_id,'observation_id',i.observation_id,'source_record_id',i.source_record_id),
      CASE WHEN r.rank<$3 THEN 'reused' WHEN s.stage='normalize' AND ${VALID} AND ${READY}
        AND a.status IN ('succeeded','reused') AND a.output->>'normalization_id'=rp.active_normalization_id::text THEN 'reused'
        ELSE 'pending' END,a.output
    FROM research_ingest_run_items i CROSS JOIN unnest($2::text[]) WITH ORDINALITY AS s(stage,ordinal)
    CROSS JOIN LATERAL (SELECT (s.ordinal-1)::int AS rank) r
    LEFT JOIN research_pois rp ON rp.id=i.research_poi_id LEFT JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id
    LEFT JOIN LATERAL (SELECT status,output FROM research_ingest_attempts a WHERE a.run_id=i.run_id AND a.target_key=i.source_record_id
      AND s.stage='normalize' AND a.stage=s.stage ORDER BY a.started_at DESC,a.id DESC LIMIT 1) a ON true
    WHERE i.run_id=$1 ON CONFLICT(run_id,source_record_id,stage) DO NOTHING`,
    [run, RECORD_STAGES, fromRank],
  );
  // Source ownership is acquired before this function; no live predecessor may still commit.
  await db.query(
    `UPDATE research_ingest_tasks SET state='pending',claim_token=NULL,execution_id=NULL,updated_at=now()
    WHERE run_id=$1 AND state IN ('running','paused','waiting_budget')`,
    [run],
  );
  // Output changes cannot hide behind an old successful checkpoint.
  await db.query(
    `UPDATE research_ingest_tasks t SET state='pending',output=NULL,updated_at=now()
    FROM research_ingest_run_items i JOIN research_pois rp ON rp.id=i.research_poi_id
    WHERE t.run_id=$1 AND i.run_id=t.run_id AND i.source_record_id=t.source_record_id AND t.rank >= $2
    AND NOT EXISTS(SELECT 1 FROM research_ingest_issues x WHERE x.run_id=t.run_id AND x.source_record_id=t.source_record_id AND x.status='excluded')
    AND t.state IN ('succeeded','reused') AND ((t.stage='normalize' AND (rp.normalization_state IN ('failed','pending','active_stale')
      OR t.output->>'normalization_id' IS DISTINCT FROM rp.active_normalization_id::text))
      OR (t.stage='geocode' AND rp.is_poi AND NOT COALESCE(${locationReadySql()},false))
      OR (t.stage='embed' AND rp.is_poi AND t.output->>'embedding_id' IS DISTINCT FROM rp.active_embedding_id::text)
      OR (t.stage IN ('match','canonical','verify') AND rp.is_poi AND
        (t.output->>'canonical_id' IS DISTINCT FROM rp.canonical_poi_id::text OR EXISTS(
          SELECT 1 FROM canonical_pois cp WHERE cp.id=rp.canonical_poi_id AND t.output->>'build_id' IS DISTINCT FROM cp.active_build_id::text))))`,
    [run, fromRank],
  );
  await db.query(
    `UPDATE research_ingest_tasks t SET state='reused',output=jsonb_build_object('status','reused','geocode_id',rp.active_geocode_id,'reason','location_enrichment_current'),finished_at=now()
    FROM research_ingest_run_items i JOIN research_pois rp ON rp.id=i.research_poi_id
    JOIN research_ingest_tasks n ON n.run_id=i.run_id AND n.source_record_id=i.source_record_id AND n.stage='normalize'
    WHERE t.run_id=$1 AND i.run_id=t.run_id AND i.source_record_id=t.source_record_id AND t.stage='geocode' AND t.state='pending'
      AND n.state IN ('succeeded','reused') AND rp.is_poi AND rp.active_observation_id=i.observation_id
      AND rp.lat IS NOT NULL AND rp.lng IS NOT NULL AND COALESCE(${locationReadySql()},false)`,
    [run],
  );
  await db.query(
    "UPDATE research_ingest_executions SET scheduler_version=2 WHERE id=$1",
    [execution],
  );
}
export async function claimTasks(
  db: Pool,
  run: string,
  execution: string,
  stage: RecordStage,
  limit = 1,
): Promise<TaskClaim[]> {
  const token = randomUUID();
  const { rows } = await db.query(
    `WITH selected AS (
    SELECT t.run_id,t.source_record_id,t.stage FROM research_ingest_tasks t JOIN research_ingest_run_items i USING(run_id,source_record_id)
    WHERE t.run_id=$1 AND t.stage=$3 AND t.state='pending'
      AND NOT EXISTS(SELECT 1 FROM research_ingest_tasks p WHERE p.run_id=t.run_id
        AND p.source_record_id=t.source_record_id AND p.rank<t.rank AND p.state NOT IN ('succeeded','reused','skipped'))
      AND NOT EXISTS(SELECT 1 FROM research_ingest_issues x WHERE x.run_id=t.run_id AND x.source_record_id=t.source_record_id AND x.status='excluded')
    ORDER BY i.source_ordinal,i.source_record_id FOR UPDATE OF t SKIP LOCKED LIMIT $5
  ), claimed AS (UPDATE research_ingest_tasks t SET state='running',execution_id=$2,claim_token=$4,started_at=clock_timestamp(),
    finished_at=NULL,updated_at=now() FROM selected s WHERE (t.run_id,t.source_record_id,t.stage)=(s.run_id,s.source_record_id,s.stage) RETURNING t.*)
    SELECT c.run_id,c.source_record_id,c.stage,c.rank,c.execution_id,c.claim_token,i.research_poi_id,i.observation_id
    FROM claimed c JOIN research_ingest_run_items i USING(run_id,source_record_id)`,
    [run, execution, stage, token, limit],
  );
  return rows;
}
export async function fenceTask(client: PoolClient, claim: TaskClaim) {
  const { rows } = await client.query(
    `SELECT t.stage FROM research_ingest_tasks t JOIN research_ingest_executions e ON e.id=t.execution_id
    JOIN research_ingest_run_items i ON i.run_id=t.run_id AND i.source_record_id=t.source_record_id JOIN research_pois rp ON rp.id=i.research_poi_id
    WHERE t.run_id=$1 AND t.source_record_id=$2 AND t.stage=$3 AND t.claim_token=$4 AND t.execution_id=$5
      AND t.state='running' AND e.status='running' AND rp.active_observation_id=$6 AND rp.retired_at IS NULL
    FOR UPDATE OF t`,
    [
      claim.run_id,
      claim.source_record_id,
      claim.stage,
      claim.claim_token,
      claim.execution_id,
      claim.observation_id,
    ],
  );
  if (!rows.length)
    throw Object.assign(
      new Error("Stale task claim or changed input; activation refused"),
      { code: "stale_task_claim" },
    );
}
export async function finishTask(
  client: PoolClient,
  claim: TaskClaim,
  attemptId: string,
  output: AttemptResult,
) {
  await fenceTask(client, claim);
  await client.query(
    `UPDATE research_ingest_attempts SET status=$2,output=$3,finished_at=clock_timestamp() WHERE id=$1 AND status='running'`,
    [attemptId, output.status, JSON.stringify(output)],
  );
  const state = output.status === "blocked" ? "quarantined" : output.status;
  await client.query(
    `UPDATE research_ingest_tasks SET state=$6,attempt_id=$7,output=$8,finished_at=clock_timestamp(),updated_at=now()
    WHERE run_id=$1 AND source_record_id=$2 AND stage=$3 AND claim_token=$4 AND execution_id=$5`,
    [
      claim.run_id,
      claim.source_record_id,
      claim.stage,
      claim.claim_token,
      claim.execution_id,
      state,
      attemptId,
      JSON.stringify(output),
    ],
  );
  // A resumed geocode may activate new location/build inputs after seedTasks has
  // already accepted the old embedding and downstream checkpoints. Re-evaluate
  // those checkpoints in the same transaction as activation, before they can be
  // claimed or mistaken for current verification. Current artifacts remain reusable.
  if (
    ["normalize", "geocode"].includes(claim.stage) &&
    ["succeeded", "reused"].includes(output.status)
  )
    await client.query(
      `UPDATE research_ingest_tasks SET state='pending',output=NULL,finished_at=NULL,updated_at=now() WHERE run_id=$1 AND source_record_id=$2 AND rank>$3 AND state IN ('succeeded','reused','skipped')`,
      [claim.run_id, claim.source_record_id, claim.rank],
    );
  if (output.status === "blocked")
    await recordIssue(
      client,
      claim,
      "record_blocked",
      String(output.reason ?? "Required record output unavailable"),
      output,
    );
  else if (["succeeded", "reused", "skipped"].includes(output.status))
    await client.query(
      `UPDATE research_ingest_issues SET status='resolved',last_seen_at=now()
    WHERE run_id=$1 AND source_record_id=$2 AND stage=$3 AND status='open'`,
      [claim.run_id, claim.source_record_id, claim.stage],
    );
  if (
    claim.stage === "verify" &&
    ["succeeded", "reused", "skipped"].includes(output.status)
  ) {
    await client.query(
      `INSERT INTO research_ingest_record_verifications(run_id,source_record_id,execution_id,observation_id,output,pipeline_versions,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(run_id,source_record_id) DO UPDATE SET execution_id=EXCLUDED.execution_id,
      observation_id=EXCLUDED.observation_id,output=EXCLUDED.output,pipeline_versions=EXCLUDED.pipeline_versions,outcome=EXCLUDED.outcome,verified_at=now()`,
      [
        claim.run_id,
        claim.source_record_id,
        claim.execution_id,
        claim.observation_id,
        JSON.stringify(output),
        JSON.stringify(PIPELINE_VERSIONS),
        output.status === "skipped" ? "non_poi" : "ready",
      ],
    );
  }
}
export async function recordIssue(
  db: Pool | PoolClient,
  claim: TaskClaim,
  code: string,
  message: string,
  evidence: unknown,
) {
  await db.query(
    `INSERT INTO research_ingest_issues(run_id,source_record_id,stage,code,scope,severity,message,evidence,retryable)
    VALUES($1,$2,$3,$4,'record','blocking',$5,$6,false) ON CONFLICT(run_id,source_record_id,stage,code) DO UPDATE SET
    message=EXCLUDED.message,evidence=EXCLUDED.evidence,status='open',last_seen_at=now()`,
    [
      claim.run_id,
      claim.source_record_id,
      claim.stage,
      code,
      message,
      JSON.stringify(evidence),
    ],
  );
}
export async function failTask(
  db: Pool,
  claim: TaskClaim,
  error: { message: string; code?: string },
  quarantine: boolean,
) {
  await db.query(
    `UPDATE research_ingest_tasks SET state=$6,updated_at=now() WHERE run_id=$1 AND source_record_id=$2 AND stage=$3 AND claim_token=$4 AND execution_id=$5`,
    [
      claim.run_id,
      claim.source_record_id,
      claim.stage,
      claim.claim_token,
      claim.execution_id,
      quarantine ? "quarantined" : "paused",
    ],
  );
  if (quarantine)
    await recordIssue(
      db,
      claim,
      error.code ?? "record_validation",
      error.message,
      error,
    );
}
export async function taskCounts(db: Pool, run: string) {
  return (
    await db.query(
      `SELECT stage,state,count(*)::int AS records,max(finished_at) AS last_commit_at FROM research_ingest_tasks WHERE run_id=$1 GROUP BY stage,state ORDER BY stage,state`,
      [run],
    )
  ).rows;
}

/** Quarantined/excluded records deliberately stop; every other selected task must finish. */
export async function unfinishedTaskCounts(
  db: Pool,
  run: string,
  from: number,
  through: number,
) {
  return (
    await db.query(
      `WITH blocked_records AS (
      SELECT source_record_id FROM research_ingest_tasks WHERE run_id=$1 AND state='quarantined'
      UNION SELECT source_record_id FROM research_ingest_issues WHERE run_id=$1 AND status='excluded'
    ) SELECT t.stage,t.state,count(*)::int AS records FROM research_ingest_tasks t
    LEFT JOIN blocked_records b USING(source_record_id)
    WHERE t.run_id=$1 AND t.rank BETWEEN $2 AND $3 AND b.source_record_id IS NULL
      AND t.state NOT IN ('succeeded','reused','skipped') GROUP BY t.stage,t.state ORDER BY t.stage,t.state`,
      [run, from, through],
    )
  ).rows;
}
