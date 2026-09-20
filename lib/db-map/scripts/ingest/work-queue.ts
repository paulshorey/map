import type { Pool } from "pg";
import { Execution, type AttemptResult } from "./execution.js";
import {
  findReusableNormalizations,
  type NormalizeOptions,
} from "./normalize/runner.js";

export interface WorkItem {
  source_record_id: string;
  research_poi_id: string | null;
  observation_id: string | null;
}
const COMPLETED = `WITH latest AS (
  SELECT DISTINCT ON(target_key) target_key,status,output FROM research_ingest_attempts
  WHERE run_id=$1 AND stage=$2 ORDER BY target_key,started_at DESC,id DESC
)
SELECT i.source_record_id,i.research_poi_id,i.observation_id,
  COALESCE(a.status IN ('succeeded','reused','skipped') AND CASE
    WHEN $2='normalize' THEN true
    WHEN NOT rp.is_poi THEN a.status='skipped'
    WHEN $2='geocode' THEN rp.lat IS NOT NULL AND rp.lng IS NOT NULL AND a.output->>'geocode_id' IS NOT DISTINCT FROM rp.active_geocode_id::text
    WHEN $2='embed' THEN rp.content_embedding IS NOT NULL AND rp.active_embedding_id IS NOT NULL AND a.output->>'embedding_id'=rp.active_embedding_id::text
    ELSE rp.canonical_poi_id IS NOT NULL AND cp.active_build_id IS NOT NULL
      AND a.output->>'canonical_id'=rp.canonical_poi_id::text AND a.output->>'build_id'=cp.active_build_id::text
  END,false) AS done
FROM research_ingest_run_items i LEFT JOIN latest a ON a.target_key=i.source_record_id
LEFT JOIN research_pois rp ON rp.id=i.research_poi_id
LEFT JOIN canonical_pois cp ON cp.id=rp.canonical_poi_id
WHERE i.run_id=$1`;

/** Filter on durable per-record checkpoints, not a numeric ID/offset that can skip holes. */
export async function pendingStageItems(
  db: Pool,
  runId: string,
  stage: string,
) {
  return (
    await db.query<WorkItem>(
      `SELECT p.source_record_id,p.research_poi_id,p.observation_id
    FROM (${COMPLETED}) p JOIN research_ingest_run_items i ON i.run_id=$1 AND i.source_record_id=p.source_record_id
    WHERE NOT p.done ORDER BY i.source_ordinal,i.source_record_id`,
      [runId, stage],
    )
  ).rows;
}

async function reusableDownstream(
  db: Pool,
  runId: string,
  stage: string,
  items: WorkItem[],
) {
  return (
    await db.query<{
      source_record_id: string;
      research_poi_id: string;
      observation_id: string;
      output: AttemptResult;
    }>(
      `
    SELECT i.source_record_id,i.research_poi_id,i.observation_id,
      CASE WHEN NOT rp.is_poi THEN jsonb_build_object('status','skipped','reason','non_poi','normalization_id',n.id)
        WHEN $2='geocode' THEN jsonb_build_object('status','reused','reason','coordinates_present','geocode_id',g.id)
        WHEN $2='embed' THEN jsonb_build_object('status','reused','embedding_id',em.id)
        ELSE jsonb_build_object('status','reused','canonical_id',cp.id,'build_id',b.id,'publication_status',cp.status)
      END || jsonb_build_object('reuse_mode','batch_existing_output') AS output
    FROM research_ingest_run_items i JOIN research_pois rp ON rp.id=i.research_poi_id
      AND rp.active_observation_id=i.observation_id AND rp.retired_at IS NULL
    JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id AND n.observation_id=i.observation_id
    LEFT JOIN research_poi_geocodes g ON g.id=rp.active_geocode_id AND g.normalization_id=n.id
    LEFT JOIN research_poi_embeddings em ON em.id=rp.active_embedding_id AND em.normalization_id=n.id
    LEFT JOIN research_canonical_memberships m ON m.research_poi_id=rp.id AND m.active AND m.normalization_id=n.id AND m.canonical_poi_id=rp.canonical_poi_id
    LEFT JOIN canonical_pois cp ON cp.id=m.canonical_poi_id
    LEFT JOIN canonical_poi_builds b ON b.id=cp.active_build_id
    WHERE i.run_id=$1 AND i.source_record_id=ANY($3::text[]) AND rp.normalization_state IN ('active','degraded','rejected')
      AND (NOT rp.is_poi OR CASE
        WHEN $2='geocode' THEN rp.lat IS NOT NULL AND rp.lng IS NOT NULL AND (rp.active_geocode_id IS NULL OR g.id IS NOT NULL)
        WHEN $2='embed' THEN rp.content_embedding IS NOT NULL AND em.id IS NOT NULL
        ELSE b.id IS NOT NULL AND EXISTS(SELECT 1 FROM canonical_poi_build_inputs bi WHERE bi.build_id=b.id
          AND bi.membership_id=m.id AND bi.normalization_id=n.id
          AND bi.embedding_id IS NOT DISTINCT FROM rp.active_embedding_id
          AND bi.geocode_id IS NOT DISTINCT FROM rp.active_geocode_id)
      END)`,
      [runId, stage, items.map((i) => i.source_record_id)],
    )
  ).rows;
}

/** This is metadata/cache work only: no provider calls or artifact activation. */
export async function prepareStageQueue(
  db: Pool,
  ex: Execution,
  stage: string,
  scopeSize: number,
  normalize: NormalizeOptions,
  batchSize = 500,
) {
  const began = performance.now();
  const pending = await pendingStageItems(db, ex.runId, stage);
  const completed = scopeSize - pending.length;
  let reused = 0;
  for (let offset = 0; offset < pending.length; offset += batchSize) {
    ex.check();
    if (ex.stopped) break;
    const batch = pending.slice(offset, offset + batchSize);
    if (stage === "normalize") {
      const cached = await findReusableNormalizations(
        db,
        normalize,
        batch.flatMap((i) => (i.research_poi_id ? [i.research_poi_id] : [])),
      );
      reused += await ex.reuseBatch(
        stage,
        cached.map((c) => ({
          input: {
            source_record_id: c.source_record_id,
            research_poi_id: c.research_poi_id,
            observation_id: c.observation_id,
          },
          output: {
            status: "reused",
            normalization_id: c.normalization_id,
            active: true,
            cacheHits: 1,
            input_hash: c.input_hash,
            reuse_mode: "batch_active_cache",
          },
        })),
      );
    } else {
      const cached = await reusableDownstream(db, ex.runId, stage, batch);
      reused += await ex.reuseBatch(
        stage,
        cached.map(({ output, ...input }) => ({ input, output })),
      );
    }
    // Keep large cache scans understandable without printing one line for every hit.
    if (
      offset + batchSize < pending.length &&
      (offset + batchSize) % 5000 === 0
    )
      console.log(
        `${stage}: checked ${offset + batchSize}/${pending.length} pending records; ${reused} reusable outputs`,
      );
  }
  const work = await pendingStageItems(db, ex.runId, stage);
  const summary = {
    scope: scopeSize,
    checkpointed: completed,
    reused,
    pending: work.length,
    preparationMs: Math.round(performance.now() - began),
  };
  await db.query(
    `UPDATE research_ingest_runs SET current_stage=$2,
    counters=jsonb_set(counters,'{queue}',COALESCE(counters->'queue','{}'::jsonb)||jsonb_build_object($2::text,$3::jsonb)) WHERE id=$1`,
    [ex.runId, stage, JSON.stringify(summary)],
  );
  console.log(
    `${stage}: ${scopeSize} in scope; ${completed} checkpointed; ${reused} reused in batches; ${work.length} need work (${summary.preparationMs}ms preparation)`,
  );
  return { items: work, ...summary };
}
