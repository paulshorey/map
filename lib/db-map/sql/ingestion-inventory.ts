import type { Pool, PoolClient } from "pg";
import {
  assessFile,
  shellQuote,
  type Evidence,
} from "../lib/ingestion/assessment.js";
import { PIPELINE_VERSIONS } from "../scripts/ingest/pipeline-versions.js";
import {
  assertValidCategory,
  listCategorySlugs,
} from "../scripts/ingest/taxonomy.js";

// The same snapshot and assessment powers the dashboard and CLI. No provider work here.
const INVENTORY_SQL = `
WITH current_versions AS (
  SELECT i.id AS inventory_id,v.* FROM research_ingest_inventory i
  JOIN research_source_files f ON f.logical_path=i.logical_path AND f.category_slug=i.category_slug
  JOIN research_sources s ON s.id=f.source_id AND s.slug=i.source_slug
  JOIN research_source_file_versions v ON v.source_file_id=f.id AND v.file_sha256=i.file_sha256
    AND v.extractor_version=i.extractor_version
), records AS (
  SELECT DISTINCT ON(v.inventory_id,rr.source_record_id) v.inventory_id,rr.source_record_id,rr.research_poi_id,rr.observation_id
  FROM current_versions v JOIN research_ingest_run_records rr ON rr.source_file_version_id=v.id
  JOIN research_ingest_runs r ON r.id=rr.run_id
  JOIN research_ingest_inventory i ON i.id=v.inventory_id AND i.category_slug=r.category_slug
  WHERE rr.extract_state IN ('written','unchanged') AND rr.source_record_id IS NOT NULL
  ORDER BY v.inventory_id,rr.source_record_id,rr.last_attempt_at DESC,rr.id DESC
), verified_items AS (
  SELECT v.inventory_id,ri.observation_id,max(r.verified_at) AS verified_at
  FROM current_versions v JOIN research_ingest_runs r ON r.source_file_version_id=v.id
  JOIN research_ingest_inventory i ON i.id=v.inventory_id AND i.category_slug=r.category_slug
  JOIN research_ingest_run_items ri ON ri.run_id=r.id
  WHERE r.managed AND r.status='succeeded' AND r.verified_at IS NOT NULL AND r.pipeline_versions=$1::jsonb
  GROUP BY v.inventory_id,ri.observation_id
), evidence AS (
  SELECT a.*,rp.is_poi,rp.normalization_state,
    (rp.id IS NOT NULL AND rp.retired_at IS NULL AND rp.active_observation_id=a.observation_id) AS input_valid,
    (n.id IS NOT NULL AND n.observation_id=a.observation_id AND rp.normalization_state IN ('active','degraded','rejected')) AS normalized,
    (rp.lat IS NOT NULL AND rp.lng IS NOT NULL AND (rp.coordinate_source IS DISTINCT FROM 'geocode' OR g.id IS NOT NULL)) AS coordinates,
    (rp.content_embedding IS NOT NULL AND em.id IS NOT NULL) AS embedded,
    (cp.id IS NOT NULL AND b.id IS NOT NULL AND m.id IS NOT NULL AND EXISTS (
      SELECT 1 FROM canonical_poi_build_inputs bi WHERE bi.build_id=b.id AND bi.membership_id=m.id
        AND bi.normalization_id=rp.active_normalization_id
        AND bi.embedding_id IS NOT DISTINCT FROM rp.active_embedding_id
        AND bi.geocode_id IS NOT DISTINCT FROM rp.active_geocode_id)) AS linked,
    cp.status AS publication_status,
    (vi.verified_at IS NOT NULL AND n.activated_at<=vi.verified_at
      AND (NOT rp.is_poi OR (em.activated_at<=vi.verified_at AND b.activated_at<=vi.verified_at
        AND (g.id IS NULL OR g.activated_at<=vi.verified_at)))) AS verified
  FROM records a LEFT JOIN research_pois rp ON rp.id=a.research_poi_id
  LEFT JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id
  LEFT JOIN research_poi_geocodes g ON g.id=rp.active_geocode_id AND g.normalization_id=n.id
  LEFT JOIN research_poi_embeddings em ON em.id=rp.active_embedding_id AND em.normalization_id=n.id
  LEFT JOIN research_canonical_memberships m ON m.research_poi_id=rp.id AND m.active AND m.normalization_id=n.id AND m.canonical_poi_id=rp.canonical_poi_id
  LEFT JOIN canonical_pois cp ON cp.id=m.canonical_poi_id
  LEFT JOIN canonical_poi_builds b ON b.id=cp.active_build_id
  LEFT JOIN verified_items vi ON vi.inventory_id=a.inventory_id AND vi.observation_id=a.observation_id
), flags AS (
  SELECT *, input_valid AND normalized AND (NOT is_poi OR (coordinates AND embedded AND linked)) AS ready FROM evidence
), counts AS (
  SELECT inventory_id,count(*)::int AS records,
    count(*) FILTER(WHERE NOT COALESCE(input_valid,false))::int AS invalid,
    count(*) FILTER(WHERE input_valid AND normalized)::int AS normalized,
    count(*) FILTER(WHERE input_valid AND normalized AND NOT is_poi)::int AS excluded,
    count(*) FILTER(WHERE input_valid AND is_poi AND coordinates)::int AS coordinates,
    count(*) FILTER(WHERE input_valid AND normalized AND is_poi AND embedded)::int AS embedded,
    count(*) FILTER(WHERE input_valid AND normalized AND is_poi AND linked)::int AS linked,
    count(*) FILTER(WHERE ready AND is_poi AND publication_status='published')::int AS published,
    count(*) FILTER(WHERE normalization_state IN ('failed','active_stale'))::int AS normalization_failed,
    count(*) FILTER(WHERE normalization_state='degraded')::int AS degraded,
    count(*) FILTER(WHERE ready)::int AS ready,
    count(*) FILTER(WHERE ready AND verified)::int AS verified
  FROM flags GROUP BY inventory_id
)
SELECT i.*,
  EXISTS(SELECT 1 FROM research_source_files f WHERE f.logical_path=i.logical_path) AS has_history,
  EXISTS(SELECT 1 FROM current_versions v WHERE v.inventory_id=i.id) AS current_version,
  EXISTS(SELECT 1 FROM current_versions v WHERE v.inventory_id=i.id AND v.status='complete') AS extraction_complete,
  (SELECT max(v.record_count) FROM current_versions v WHERE v.inventory_id=i.id AND v.status='complete') AS source_rows,
  COALESCE(c.records,0) AS records,COALESCE(c.invalid,0) AS invalid,COALESCE(c.normalized,0) AS normalized,
  COALESCE(c.excluded,0) AS excluded,COALESCE(c.coordinates,0) AS coordinates,COALESCE(c.embedded,0) AS embedded,
  COALESCE(c.linked,0) AS linked,COALESCE(c.published,0) AS published,COALESCE(c.ready,0) AS ready,
  COALESCE(c.verified,0) AS verified,COALESCE(c.normalization_failed,0) AS normalization_failed,COALESCE(c.degraded,0) AS degraded,
  (SELECT to_jsonb(x) FROM (
    SELECT r.id,r.managed,r.status,r.current_stage,r.options,r.category_slug,r.pipeline_versions,
      r.stop_requested,r.stop_reason,r.fatal_error,r.verified_at,r.created_at,
      COALESCE(e.heartbeat_at,r.heartbeat_at) AS heartbeat_at,e.host,e.pid,
      COALESCE(e.started_at,r.started_at,r.created_at) AS execution_started_at,v.file_sha256,v.extractor_version
    FROM research_source_files f JOIN research_source_file_versions v ON v.source_file_id=f.id
    JOIN research_ingest_runs r ON r.source_file_version_id=v.id
    LEFT JOIN LATERAL (SELECT * FROM research_ingest_executions e WHERE e.run_id=r.id ORDER BY e.started_at DESC LIMIT 1) e ON true
    WHERE f.logical_path=i.logical_path
    ORDER BY COALESCE(e.started_at,r.started_at,r.created_at) DESC,r.id DESC LIMIT 1
  ) x) AS latest_run,
  (SELECT max(a.finished_at) FROM research_source_files f JOIN research_source_file_versions v ON v.source_file_id=f.id
    JOIN research_ingest_runs r ON r.source_file_version_id=v.id JOIN research_ingest_attempts a ON a.run_id=r.id
    WHERE f.logical_path=i.logical_path AND a.status IN ('succeeded','reused','skipped')) AS last_commit_at
FROM research_ingest_inventory i LEFT JOIN counts c ON c.inventory_id=i.id
ORDER BY i.priority DESC,i.logical_path`;

export interface InventoryFile extends Evidence {
  id: string;
  logical_path: string;
  source_slug: string | null;
  extractor_version: string | null;
  byte_size: string;
  modified_at: string;
  scanned_at: string;
  first_seen_at: string;
  notes: string;
  updated_at: string;
  priority: number;
  published: number;
  degraded: number;
  last_commit_at: string | null;
  source_rows: number | null;
}
export async function getInventory(db: Pool) {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='15s'");
    const { rows } = await client.query<InventoryFile>(INVENTORY_SQL, [
      JSON.stringify(PIPELINE_VERSIONS),
    ]);
    const files = rows.map((file) => {
      const assessment = assessFile(file);
      const commandPrefix = "pnpm --filter @lib/db-map ingest:run";
      const start =
        file.category_slug &&
        file.source_slug &&
        !file.missing_at &&
        !file.scan_error &&
        file.disposition === "import" &&
        ["json", "jsonl", "csv"].includes(file.format)
          ? `${commandPrefix} ${shellQuote(file.logical_path)} --category ${shellQuote(file.category_slug)}`
          : null;
      const r = file.latest_run;
      const resume =
        r &&
        r.file_sha256 === file.file_sha256 &&
        r.extractor_version === file.extractor_version &&
        r.category_slug === file.category_slug &&
        (!r.managed ||
          Object.entries(PIPELINE_VERSIONS).every(
            ([k, v]) => r.pipeline_versions[k] === v,
          )) &&
        start &&
        !["succeeded", "cancelled"].includes(r.status)
          ? `${commandPrefix} --resume ${r.id}`
          : null;
      return {
        ...file,
        ...assessment,
        commands: {
          start,
          resume,
          verify:
            start && file.ready === file.records && file.extraction_complete
              ? `${start} --from report`
              : null,
          status: r
            ? `pnpm --filter @lib/db-map ingest:status --run ${r.id} --json`
            : null,
        },
      };
    });
    await client.query("ROLLBACK");
    return {
      inspectedAt: new Date().toISOString(),
      categories: listCategorySlugs(),
      files,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export type InventorySnapshot = Awaited<ReturnType<typeof getInventory>>;
export const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export async function editInventory(db: Pool, id: string, input: unknown) {
  if (
    !UUID.test(id) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    throw new Error("Invalid inventory edit");
  const x = input as Record<string, unknown>;
  if (
    Object.keys(x).some(
      (k) =>
        ![
          "notes",
          "priority",
          "category_slug",
          "disposition",
          "expected_updated_at",
        ].includes(k),
    )
  )
    throw new Error("Unknown edit field");
  if (
    typeof x.notes !== "string" ||
    x.notes.length > 10000 ||
    !Number.isInteger(x.priority) ||
    Number(x.priority) < 0 ||
    Number(x.priority) > 3 ||
    !["needs_review", "import", "alternate", "supporting", "ignored"].includes(
      String(x.disposition),
    )
  )
    throw new Error("Invalid notes, priority or disposition");
  if (x.category_slug !== null) {
    if (typeof x.category_slug !== "string")
      throw new Error("Invalid category");
    assertValidCategory(x.category_slug);
  }
  if (x.disposition === "import" && !x.category_slug)
    throw new Error("Choose a category before marking a file for import");
  if (
    ["alternate", "supporting", "ignored"].includes(String(x.disposition)) &&
    !x.notes.trim()
  )
    throw new Error("Record a reason in notes for excluding this file");
  if (
    typeof x.expected_updated_at !== "string" ||
    !Number.isFinite(Date.parse(x.expected_updated_at))
  )
    throw new Error(
      "Read the current file before editing (expected_updated_at required)",
    );
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const previous = (
      await client.query(
        "SELECT notes,priority,category_slug,disposition,updated_at FROM research_ingest_inventory WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!previous) throw new Error("Unknown inventory file");
    if (
      new Date(previous.updated_at).getTime() !==
      Date.parse(x.expected_updated_at as string)
    )
      throw new Error(
        "Notes changed in another session. Reopen the file and merge your changes before saving.",
      );
    const updated = await client.query(
      `UPDATE research_ingest_inventory SET notes=$2,priority=$3,category_slug=$4,disposition=$5,updated_at=clock_timestamp() WHERE id=$1 RETURNING updated_at`,
      [id, x.notes, x.priority, x.category_slug, x.disposition],
    );
    await client.query(
      "INSERT INTO research_ingest_inventory_edits(inventory_id,previous,updated) VALUES($1,$2,$3)",
      [id, JSON.stringify(previous), JSON.stringify(x)],
    );
    await client.query("COMMIT");
    return { saved: true, updated_at: updated.rows[0].updated_at };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function pauseIngestion(db: Pool, runId: string) {
  if (!UUID.test(runId)) throw new Error("Invalid run UUID");
  const result = await db.query(
    "UPDATE research_ingest_runs SET stop_requested=true WHERE id=$1 AND managed AND status='running'",
    [runId],
  );
  if (!result.rowCount) throw new Error("No running managed run with this ID");
  return { requested: true };
}
export async function getInventoryDetail(db: Pool, id: string) {
  if (!UUID.test(id)) throw new Error("Invalid file UUID");
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='15s'");
    const inventory = (
      await client.query(
        "SELECT * FROM research_ingest_inventory WHERE id=$1",
        [id],
      )
    ).rows[0];
    if (!inventory) throw new Error("Unknown inventory file");
    const values = [inventory.logical_path];
    const rows = async (sql: string, args: unknown[] = values) =>
      (await client.query(sql, args)).rows;
    const runs = await rows(`SELECT r.*,v.file_sha256,v.extractor_version,
      (SELECT max(e.started_at) FROM research_ingest_executions e WHERE e.run_id=r.id) AS last_execution_at,
      (SELECT count(*)::int FROM research_ingest_run_items i WHERE i.run_id=r.id) AS scope_records
      FROM research_ingest_runs r JOIN research_source_file_versions v ON v.id=r.source_file_version_id
      JOIN research_source_files f ON f.id=v.source_file_id WHERE f.logical_path=$1
      ORDER BY COALESCE((SELECT max(e.started_at) FROM research_ingest_executions e WHERE e.run_id=r.id),r.created_at) DESC LIMIT 30`);
    const versions = await rows(
      `SELECT v.* FROM research_source_file_versions v JOIN research_source_files f ON f.id=v.source_file_id WHERE f.logical_path=$1 ORDER BY v.created_at DESC LIMIT 30`,
    );
    const discoveredVersions = await rows(
      "SELECT * FROM research_ingest_inventory_versions WHERE inventory_id=$1 ORDER BY last_seen_at DESC LIMIT 30",
      [id],
    );
    const edits = await rows(
      "SELECT * FROM research_ingest_inventory_edits WHERE inventory_id=$1 ORDER BY created_at DESC LIMIT 10",
      [id],
    );
    const metrics =
      await rows(`SELECT count(*)::int AS requests,count(*) FILTER(WHERE q.status='failed')::int AS failed_requests,
      sum(q.estimated_cost_usd)::float AS cost_usd,avg(extract(epoch FROM(q.completed_at-q.created_at)))::float AS mean_seconds,
      count(*) FILTER(WHERE q.repaired_from_id IS NOT NULL)::int AS repair_requests,
      sum(q.prompt_tokens)::float AS prompt_tokens,sum(q.completion_tokens)::float AS completion_tokens
      FROM research_normalization_requests q JOIN research_ingest_runs r ON r.id=q.run_id
      JOIN research_source_file_versions v ON v.id=r.source_file_version_id JOIN research_source_files f ON f.id=v.source_file_id WHERE f.logical_path=$1`);
    const stageMetrics = await rows(`SELECT a.stage,count(*)::int AS attempts,
      count(*) FILTER(WHERE a.status='failed')::int AS failed,
      count(*) FILTER(WHERE a.status='reused')::int AS reused,
      avg(extract(epoch FROM(a.finished_at-a.started_at)))::float AS mean_seconds
      FROM research_ingest_attempts a JOIN research_ingest_runs r ON r.id=a.run_id
      JOIN research_source_file_versions v ON v.id=r.source_file_version_id
      JOIN research_source_files f ON f.id=v.source_file_id WHERE f.logical_path=$1
      GROUP BY a.stage ORDER BY a.stage`);
    await client.query("ROLLBACK");
    return {
      stageMetrics,
      inventory,
      runs,
      versions,
      discoveredVersions,
      edits,
      metrics: metrics[0],
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
