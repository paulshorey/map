/** Read-only evidence for the latest recorded ingestion attempt, or a pinned run. */
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";

export interface StatusOptions {
  run: string;
  source?: string;
  category?: string;
  limit: number;
  json: boolean;
  help: boolean;
}

const USAGE =
  "ingest:status [--run latest|<uuid>] [--source <slug>] [--category <slug>] [--limit 1..20] [--json]";

export function parseStatusArgs(argv: string[]): StatusOptions {
  const opts: StatusOptions = {
    run: "latest",
    limit: 5,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") opts.json = true;
    else if (arg === "--help") opts.help = true;
    else {
      if (!["--run", "--source", "--category", "--limit"].includes(arg!)) {
        throw new Error(`Unknown argument: ${arg}. Usage: ${USAGE}`);
      }
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      if (arg === "--run") opts.run = value;
      else if (arg === "--source") opts.source = value;
      else if (arg === "--category") opts.category = value;
      else opts.limit = Number(value);
    }
  }
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1 || opts.limit > 20) {
    throw new Error(
      "--limit must be an integer from 1 to 20 (samples per section)",
    );
  }
  if (
    opts.run !== "latest" &&
    !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(opts.run)
  ) {
    throw new Error("--run must be latest or a UUID");
  }
  return opts;
}

export async function inspectRun(db: Pool, opts: StatusOptions) {
  const client = await db.connect();
  try {
    // One consistent snapshot; an accidental write in a future query must fail.
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    const { rows: runs } = await client.query(
      `SELECT r.*, s.slug AS source, f.logical_path, v.file_sha256,
              v.status AS file_status, v.record_count AS file_record_count,
              v.completed_at AS file_completed_at, now() AS inspected_at
       FROM research_ingest_runs r
       JOIN research_sources s ON s.id = r.source_id
       JOIN research_source_file_versions v ON v.id = r.source_file_version_id
       JOIN research_source_files f ON f.id = v.source_file_id
       WHERE ($1::uuid IS NULL OR r.id = $1)
         AND ($2::text IS NULL OR s.slug = $2)
         AND ($3::text IS NULL OR r.category_slug = $3)
       ORDER BY greatest(r.created_at, (SELECT max(e.started_at) FROM research_ingest_executions e WHERE e.run_id=r.id)) DESC, r.id DESC LIMIT 1`,
      [
        opts.run === "latest" ? null : opts.run,
        opts.source ?? null,
        opts.category ?? null,
      ],
    );
    const run = runs[0];
    if (!run)
      throw new Error(
        "No recorded run matches these filters; no ingestion was started.",
      );
    const rows = async (sql: string, values: unknown[]) =>
      (await client.query(sql, values)).rows;
    const runValues = [run.id];
    const sampleValues = [run.id, opts.limit];
    const sourceValues = [run.source_id];
    const sourceSampleValues = [run.source_id, opts.limit];

    const extraction = await rows(
      `SELECT extract_state, count(*)::int AS records, max(source_ordinal) AS highest_ordinal,
              max(last_attempt_at) AS last_attempt_at
       FROM research_ingest_run_records WHERE run_id = $1 GROUP BY extract_state ORDER BY extract_state`,
      runValues,
    );
    const recentExtraction = await rows(
      `SELECT source_ordinal, source_record_id, research_poi_id, extract_state,
              first_attempt_at, last_attempt_at, last_error_class, left(last_error, 1000) AS error
       FROM research_ingest_run_records WHERE run_id = $1
       ORDER BY last_attempt_at DESC NULLS LAST, source_ordinal DESC LIMIT $2`,
      sampleValues,
    );
    const extractionProblems = await rows(
      `SELECT source_ordinal, source_record_id, extract_state, last_attempt_at,
              last_error_class, left(last_error, 1000) AS error
       FROM research_ingest_run_records
       WHERE run_id = $1 AND extract_state IN ('pending','failed','collision','rejected')
       ORDER BY last_attempt_at DESC NULLS LAST, source_ordinal DESC LIMIT $2`,
      sampleValues,
    );
    const jobs = await rows(
      `SELECT stage, status, count(*)::int AS jobs,
              count(*) FILTER (WHERE status = 'leased' AND lease_expires_at < now())::int AS expired_leases,
              max(started_at) AS last_started_at, max(completed_at) AS last_completed_at
       FROM research_pipeline_jobs WHERE run_id = $1 GROUP BY stage, status ORDER BY stage, status`,
      runValues,
    );
    const jobRecordSelect = `SELECT j.id, j.stage, j.status, j.target_kind, j.target_id, rp.source_record_id,
              rp.name, j.attempts, j.started_at, j.completed_at, j.lease_owner,
              j.lease_expires_at, j.error_class, left(j.error, 1000) AS error
       FROM research_pipeline_jobs j
       LEFT JOIN research_poi_observations o ON j.target_kind = 'observation' AND o.id = j.target_id
       LEFT JOIN research_poi_normalizations n ON j.target_kind = 'normalization' AND n.id = j.target_id
       LEFT JOIN research_pois rp ON rp.id = COALESCE(o.research_poi_id, n.research_poi_id,
         CASE WHEN j.target_kind = 'research_poi' THEN j.target_id END)`;
    const recentJobs = await rows(
      `${jobRecordSelect} WHERE j.run_id = $1
       ORDER BY greatest(j.started_at, j.completed_at, j.created_at) DESC, j.id DESC LIMIT $2`,
      sampleValues,
    );
    const jobProblems = await rows(
      `${jobRecordSelect} WHERE j.run_id = $1
         AND (j.status IN ('failed','retryable','quarantined')
           OR (j.status = 'leased' AND j.lease_expires_at < now()))
       ORDER BY greatest(j.started_at, j.completed_at, j.created_at) DESC, j.id DESC LIMIT $2`,
      sampleValues,
    );
    const jobErrors = await rows(
      `SELECT stage, status, error_class, left(error, 1000) AS error, count(*)::int AS jobs,
              max(completed_at) AS last_completed_at
       FROM research_pipeline_jobs WHERE run_id = $1 AND error IS NOT NULL
       GROUP BY stage, status, error_class, left(error, 1000)
       ORDER BY count(*) DESC, max(completed_at) DESC NULLS LAST LIMIT $2`,
      sampleValues,
    );
    const sourceState = await rows(
      `SELECT ingest_category, normalization_state, (retired_at IS NOT NULL) AS retired,
              count(*)::int AS records, count(active_normalization_id)::int AS active_normalizations,
              count(*) FILTER (WHERE lat IS NOT NULL AND lng IS NOT NULL)::int AS with_coords,
              count(content_embedding)::int AS embedded, count(canonical_poi_id)::int AS linked,
              count(*) FILTER (WHERE canonical_poi_id IS NULL AND is_poi
                AND lat IS NOT NULL AND lng IS NOT NULL AND name_normalized IS NOT NULL
                AND category_slugs IS NOT NULL)::int AS match_ready,
              max(normalized_at) AS last_normalized_at
       FROM research_pois WHERE source_id = $1
       GROUP BY ingest_category, normalization_state, (retired_at IS NOT NULL)
       ORDER BY ingest_category, normalization_state, retired`,
      sourceValues,
    );
    const recentSourceRecords = await rows(
      `SELECT source_record_id, name, ingest_category, normalization_state, first_seen_at,
              last_seen_at, normalized_at, active_normalization_id, canonical_poi_id, retired_at
       FROM research_pois WHERE source_id = $1
       ORDER BY greatest(first_seen_at, last_seen_at, normalized_at, retired_at) DESC, id DESC LIMIT $2`,
      sourceSampleValues,
    );
    const recentRequests = await rows(
      `SELECT q.id, rp.source_record_id, rp.name, q.status, q.created_at, q.completed_at,
              q.attempt, q.latency_ms, left(q.error, 1000) AS error
       FROM research_normalization_requests q JOIN research_pois rp ON rp.id = q.research_poi_id
       WHERE rp.source_id = $1
       ORDER BY greatest(q.created_at, q.completed_at) DESC, q.id DESC LIMIT $2`,
      sourceSampleValues,
    );
    // Each branch is bounded independently so quiet downstream stages remain visible.
    const artifacts: Record<string, unknown[]> = {};
    for (const [label, sql] of Object.entries({
      normalization: `SELECT n.id, rp.source_record_id, n.status, n.created_at, n.activated_at,
          (n.id = rp.active_normalization_id) AS is_active
        FROM research_poi_normalizations n JOIN research_pois rp ON rp.id = n.research_poi_id
        WHERE rp.source_id = $1 ORDER BY greatest(n.created_at,n.activated_at) DESC, n.id DESC LIMIT $2`,
      geocode: `SELECT g.id, rp.source_record_id, g.status, g.created_at, g.activated_at,
          (g.id = rp.active_geocode_id) AS is_active
        FROM research_poi_geocodes g JOIN research_poi_normalizations n ON n.id = g.normalization_id
        JOIN research_pois rp ON rp.id = n.research_poi_id
        WHERE rp.source_id = $1 ORDER BY greatest(g.created_at,g.activated_at) DESC, g.id DESC LIMIT $2`,
      embedding: `SELECT e.id, rp.source_record_id, e.created_at, e.activated_at,
          (e.id = rp.active_embedding_id) AS is_active
        FROM research_poi_embeddings e JOIN research_poi_normalizations n ON n.id = e.normalization_id
        JOIN research_pois rp ON rp.id = n.research_poi_id
        WHERE rp.source_id = $1 ORDER BY greatest(e.created_at,e.activated_at) DESC, e.id DESC LIMIT $2`,
      match: `SELECT d.id, rp.source_record_id, d.decision, d.method, d.candidate_poi_id, d.decided_at
        FROM research_match_decisions d JOIN research_pois rp ON rp.id = d.research_id
        WHERE rp.source_id = $1 ORDER BY d.decided_at DESC, d.id DESC LIMIT $2`,
      canonicalBuild: `SELECT b.id, b.canonical_poi_id, b.status, b.created_at, b.activated_at,
          cp.status AS current_publication_status, (cp.active_build_id = b.id) AS is_active
        FROM canonical_poi_builds b JOIN canonical_pois cp ON cp.id = b.canonical_poi_id
        WHERE EXISTS (SELECT 1 FROM canonical_poi_build_inputs i
          JOIN research_pois rp ON rp.id = i.research_poi_id
          WHERE i.build_id = b.id AND rp.source_id = $1)
        ORDER BY greatest(b.created_at,b.activated_at) DESC, b.id DESC LIMIT $2`,
    }))
      artifacts[label] = await rows(sql, sourceSampleValues);

    const executions = await rows(
      `SELECT *, now()-heartbeat_at AS heartbeat_age,
      (status='running' AND heartbeat_at < now()-interval '30 seconds') AS heartbeat_stale
      FROM research_ingest_executions WHERE run_id=$1 ORDER BY started_at DESC LIMIT $2`,
      sampleValues,
    );
    const attempts = await rows(
      `SELECT stage,status,count(*)::int AS targets FROM
      (SELECT DISTINCT ON(stage,target_key) stage,target_key,status FROM research_ingest_attempts
       WHERE run_id=$1 ORDER BY stage,target_key,started_at DESC,id DESC) latest
      GROUP BY stage,status ORDER BY stage,status`,
      runValues,
    );
    const recentAttempts = await rows(
      `SELECT id,execution_id,stage,source_record_id,target_key,status,
      input,output,error,started_at,finished_at FROM research_ingest_attempts WHERE run_id=$1
      ORDER BY greatest(started_at,finished_at) DESC,id DESC LIMIT $2`,
      sampleValues,
    );
    const attemptProblems = await rows(
      `SELECT * FROM (SELECT DISTINCT ON(stage,target_key)
      id,execution_id,stage,target_key,source_record_id,status,error,output,started_at,finished_at
      FROM research_ingest_attempts WHERE run_id=$1 ORDER BY stage,target_key,started_at DESC,id DESC) latest
      WHERE status IN ('failed','blocked','interrupted','waiting_budget','running')
      ORDER BY started_at DESC LIMIT $2`,
      sampleValues,
    );
    const scopeCounts = await rows(
      `SELECT count(*)::int AS records FROM research_ingest_run_items WHERE run_id=$1`,
      runValues,
    );
    const result = {
      run,
      executions,
      attempts,
      recentAttempts,
      attemptProblems,
      scopeRecords: scopeCounts[0]?.records ?? 0,
      interpretation: run.managed
        ? [
            "Managed scope is fixed by run items. Attempts reference the exact run, execution, record, and outputs.",
            "Heartbeat is periodic; a stale worker is suspected interrupted, not proven dead. Resume acquires the source lock before recovering attempts.",
            "Succeeded means this selected scope completed and lineage verification passed; it does not certify the entire category.",
            "At-least-once recovery can repeat a provider call if the process dies before saving its result.",
            "Legacy source-wide sections below include other runs; use managed attempts for run attribution.",
          ]
        : [
            "This is a read-only snapshot, not a liveness or completeness verdict.",
            "Run heartbeat and counters update at stage boundaries, not continuously. Running may be stale.",
            "Extraction and jobs are selected by run_id. Jobs are mutable and can be reassigned on retries.",
            "Source state, records, requests and artifacts include ALL runs/categories of this source; timestamps do not prove run attribution.",
            "first_seen_at is insertion; last_seen_at is source observation, not a general updated_at. Use stage artifacts for downstream writes.",
            "A request started or a leased job is an attempt, not a committed output. Expired leases suggest unfinished work, not its cause.",
            "Empty downstream artifacts do not prove the stage never ran; source coordinates, caches, legacy rows or exclusions may explain them.",
            "Status succeeded is recorded before report/verify finish. Confirm terminal completion, required outputs, and lineage separately.",
            "Review stored resume_command against options: it currently omits stopAfter/fromStage/reprocess/retryFailed and does not shell-quote paths.",
          ],
      extraction,
      recentExtraction,
      extractionProblems,
      jobs,
      recentJobs,
      jobProblems,
      jobErrors,
      sourceState,
      recentSourceRecords,
      recentRequests,
      recentSourceArtifacts: artifacts,
    };
    await client.query("ROLLBACK");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const opts = parseStatusArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const db = getDb();
  try {
    const result = await inspectRun(db, opts);
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      const r = result.run;
      console.log(`Run ${r.id} — ${r.source} / ${r.category_slug}`);
      console.log(
        `${r.status} at ${r.current_stage}; ${r.stop_reason ?? "no stop reason recorded"}`,
      );
      console.log(`File: ${r.logical_path}`);
      console.log(
        `Started: ${r.started_at?.toISOString()}; heartbeat: ${r.heartbeat_at?.toISOString()}`,
      );
      console.log(
        `Scope: ${r.managed ? `${result.scopeRecords} fixed records` : "legacy run (no fixed scope ledger)"}`,
      );
      if (r.fatal_error) console.log(`Error: ${r.fatal_error}`);
      for (const e of result.executions)
        console.log(
          `Execution ${e.id}: ${e.status}, ${e.host}:${e.pid}${e.heartbeat_stale ? " — STALE HEARTBEAT" : ""}`,
        );
      const recovery = r.counters?.providerRecovery;
      if (recovery && recovery.executionId === result.executions[0]?.id)
        console.log(
          `Provider recovery: ${recovery.state}; ${recovery.stage} ${recovery.target}; retries=${recovery.retry}; execution retries=${recovery.executionRetries}${recovery.retryAt ? `; retry at ${recovery.retryAt}` : ""}${recovery.reason ? `; ${recovery.reason}` : ""}`,
        );
      console.log("Stage progress (latest outcome per target):");
      for (const a of result.attempts)
        console.log(`  ${a.stage}: ${a.status}=${a.targets}`);
      if (!r.managed)
        for (const j of result.jobs)
          console.log(
            `  ${j.stage}: ${j.status}=${j.jobs}, expired leases=${j.expired_leases}`,
          );
      console.log("Latest work:");
      for (const a of result.recentAttempts)
        console.log(
          `  ${a.stage} ${a.source_record_id ?? a.target_key}: ${a.status} (${(a.finished_at ?? a.started_at).toISOString()})`,
        );
      if (!r.managed)
        for (const j of result.recentJobs)
          console.log(
            `  ${j.stage} ${j.source_record_id ?? j.target_id}: ${j.status}`,
          );
      for (const a of result.attemptProblems)
        console.log(
          `  Needs attention: ${a.stage} ${a.source_record_id ?? a.target_key}: ${a.status} ${a.error?.message ?? a.output?.reason ?? ""}`,
        );
      if (!r.managed)
        for (const e of result.jobErrors)
          console.log(`  ${e.jobs} error(s): ${e.error}`);
      if (r.verified_at)
        console.log(`Verified: ${r.verified_at.toISOString()}`);
      console.log(
        `Resume: pnpm --filter @lib/db-map ingest:run --resume ${r.id}`,
      );
      console.log(
        "Use --json for full history samples, output IDs, errors, and source-wide diagnostics.",
      );
    }
  } finally {
    await db.end();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error("Ingest status failed:", error.message);
    process.exitCode = 1;
  });
}
