import {
  assertOverview,
  type OperationsOverview,
} from "../contracts/ingestion-operations.js";
import { expectedCaptures } from "../lib/ingestion/expected-captures.js";
import { PIPELINE_VERSIONS } from "../scripts/ingest/pipeline-versions.js";
import type { Pool } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getInventory } from "./ingestion-inventory.js";
import { inspectControl } from "../scripts/ingest/control.js";
import { buildImportQueue } from "../lib/ingestion/queue.js";
export interface OverviewOptions {
  run?: string;
  file?: string;
  detail?: boolean;
  limit?: number;
  offset?: number;
  includeInventory?: boolean;
}
export function performanceOpportunities(
  metrics: any[],
  concurrency: number,
  remaining: number,
) {
  const suggestions: Array<{
    code: string;
    evidence: unknown;
    recommendation: string;
    experiment: string;
    confidence: string;
  }> = [];
  const norm = metrics.find(
    (x) => x.operation === "normalize" && Number(x.mean_latency_ms) > 0,
  );
  if (norm && concurrency < 4 && remaining > 0)
    suggestions.push({
      code: "serial_provider_wait",
      evidence: {
        mean_provider_ms: norm.mean_latency_ms,
        remaining,
        concurrency,
      },
      confidence: "measured",
      recommendation:
        "Use shared LLM concurrency 4; preserve model/prompt and checkpoints",
      experiment:
        "ingest:supervise smoke --timeout-seconds 60 -- <source-file> --category <category> --limit 3 --llm-concurrency 3 --shadow --reprocess normalize",
    });
  if (norm && concurrency >= 4 && concurrency < 16 && remaining > 1000)
    suggestions.push({
      code: "evaluate_more_concurrency",
      evidence: { concurrency, remaining, failed_requests: norm.failed },
      confidence: "conditional",
      recommendation:
        "Inspect quota headers and throttling before evaluating concurrency 8",
      experiment:
        "Compare a fixed three-record shadow selection; do not change quality settings",
    });
  const emb = metrics.find(
    (x) => x.operation === "embed" && Number(x.mean_batch_size) < 8,
  );
  if (emb)
    suggestions.push({
      code: "embedding_batch_fill",
      evidence: { mean_batch_size: emb.mean_batch_size },
      confidence: "measured",
      recommendation:
        "Compare ready embedding backlog against the batch-fill deadline",
      experiment:
        "Use recorded batches and mocked throughput; avoid extra provider calls",
    });
  if (norm)
    suggestions.push({
      code: "reasoning_quality_experiment",
      evidence: {
        reasoning_tokens: norm.mean_reasoning_tokens,
        completion_tokens: norm.mean_completion_tokens,
        latency_ms: norm.mean_latency_ms,
      },
      confidence: "hypothesis",
      recommendation:
        "Keep current settings; a lower thinking allowance or leaner prompt requires a separate quality comparison",
      experiment:
        "One fixed three-record shadow cohort with source-grounded and adversarial golden checks",
    });
  return suggestions;
}
function primaryRoot() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const common = execFileSync(
    "git",
    ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { encoding: "utf8", timeout: 3000 },
  ).trim();
  return dirname(common);
}
async function localEvidence() {
  const root = primaryRoot(),
    observed_at = new Date().toISOString();
  const base = join(root, "lib/db-map/.ingest-jobs");
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { observed_at, jobs: [], claims: [], errors: [] };
    throw error;
  }
  const jobs: any[] = [],
    claims: any[] = [],
    errors: string[] = [];
  for (const id of entries.filter((x) => /^[0-9a-f-]{36}$/i.test(x))) {
    try {
      const job = JSON.parse(
        await readFile(join(base, id, "job.json"), "utf8"),
      );
      if (job.status !== "finished")
        jobs.push({
          id: job.id,
          status: job.status,
          run_id: job.run_id ?? null,
          execution_id: job.execution_id ?? null,
          host: job.host,
          host_id: job.host_id ?? null,
          supervisor_pid: job.supervisor_pid,
          child_pid: job.child_pid,
          last_health_at: job.last_health_at ?? null,
          started_at: job.started_at,
          journal: join(base, id, "job.json"),
        });
    } catch {
      errors.push(`Unreadable job ${id}`);
    }
  }
  try {
    const imports = join(base, ".coordinator/imports");
    for (const id of (await readdir(imports)).filter((x) =>
      /^[0-9a-f-]{36}$/i.test(x),
    )) {
      const intent = JSON.parse(
        await readFile(join(imports, id, "intent.json"), "utf8"),
      );
      if (!["released", "finished", "cancelled"].includes(intent.status))
        claims.push({
          id,
          status: intent.status,
          job_id: intent.job_id ?? intent.job?.id ?? null,
          path: join(imports, id, "intent.json"),
        });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      errors.push("Coordinator claims unavailable");
  }
  return { observed_at, jobs, claims, errors };
}
export async function getOverview(
  db: Pool,
  options: OverviewOptions = {},
): Promise<OperationsOverview> {
  const local = await localEvidence().catch((error) => ({
    observed_at: new Date().toISOString(),
    jobs: [] as any[],
    claims: [] as any[],
    errors: [String(error.message)],
  }));
  const client = await db.connect().catch(() => null);
  if (!client)
    return {
      schema_version: 1,
      observed_at: new Date().toISOString(),
      components: {
        database: {
          status: "unknown",
          message: "Database connection unavailable",
        },
        local,
      },
      decision: { action: "inspect", reason: "Database evidence unavailable" },
      interventions: [
        {
          code: "database_evidence_unknown",
          scope: "global",
          severity: "blocking",
        },
      ],
      improvements: [],
      summary: null,
      files: [],
    };
  let data: OperationsOverview;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL lock_timeout='1s'");
    const inventory = await getInventory(db, { client, file: options.file });
    const control = await inspectControl(client);
    const executions = (
      await client.query(
        `SELECT e.*,r.current_stage,r.status AS run_status,r.counters,r.category_slug,s.slug AS source,f.logical_path
      FROM research_ingest_executions e JOIN research_ingest_runs r ON r.id=e.run_id JOIN research_sources s ON s.id=r.source_id
      JOIN research_source_file_versions v ON v.id=r.source_file_version_id JOIN research_source_files f ON f.id=v.source_file_id
      WHERE ($1::uuid IS NULL OR r.id=$1) AND ($2::text IS NULL OR f.logical_path=$2)
      ORDER BY (e.status='running') DESC,e.started_at DESC LIMIT 5`,
        [options.run ?? null, options.file ?? null],
      )
    ).rows;
    const run = options.run ?? executions[0]?.run_id ?? null;
    const tasks = run
      ? (
          await client.query(
            `SELECT stage,state,count(*)::int AS records,max(finished_at) AS last_commit_at,
      max(extract(epoch from clock_timestamp()-started_at)) FILTER(WHERE state='running') AS oldest_active_seconds
      FROM research_ingest_tasks WHERE run_id=$1 GROUP BY stage,state ORDER BY stage,state`,
            [run],
          )
        ).rows
      : [];
    const issues = (
      await client.query(
        `SELECT id,run_id,source_record_id,stage,code,scope,severity,message,retryable,status,first_seen_at,last_seen_at,evidence
      FROM research_ingest_issues WHERE status='open' AND ($1::uuid IS NULL OR run_id=$1) ORDER BY last_seen_at DESC LIMIT 20`,
        [options.run ?? null],
      )
    ).rows;
    const scans = (
      await client.query(
        `SELECT * FROM research_ingest_inventory_scans ORDER BY started_at DESC LIMIT 5`,
      )
    ).rows;
    const metrics = run
      ? (
          await client.query(
            `SELECT provider,operation,count(*)::int AS requests,count(*) FILTER(WHERE status='failed')::int AS failed,
      round(avg(latency_ms))::int AS mean_latency_ms,round(avg(queue_ms))::int AS mean_queue_ms,round(avg(records),1)::float AS mean_batch_size,
      percentile_cont(0.95) WITHIN GROUP(ORDER BY latency_ms) AS p95_latency_ms,round(avg(completion_tokens))::int AS mean_completion_tokens,
      round(avg(reasoning_tokens))::int AS mean_reasoning_tokens,sum(estimated_cost_usd)::float AS known_cost_usd,
      count(*) FILTER(WHERE estimated_cost_usd IS NULL AND status='succeeded')::int AS unknown_cost_calls,
      max(started_at) AS last_request_at
      FROM (SELECT * FROM research_ingest_provider_calls WHERE run_id=$1 ORDER BY started_at DESC LIMIT 1000) q
      GROUP BY provider,operation`,
            [run],
          )
        ).rows
      : [];
    const task_metrics = run
      ? (
          await client.query(
            `SELECT stage,count(*)::int AS records,
      round(avg(extract(epoch from finished_at-started_at)*1000))::int AS mean_elapsed_ms,
      round(avg((output->'metrics'->>'database_ms')::numeric))::int AS mean_database_ms,
      round(avg((output->'metrics'->>'database_queries')::numeric))::int AS mean_database_queries,
      round(avg((output->'metrics'->>'provider_ms')::numeric))::int AS mean_provider_ms,
      round(avg((output->'metrics'->>'provider_queue_ms')::numeric))::int AS mean_provider_queue_ms
      FROM (SELECT * FROM research_ingest_attempts WHERE run_id=$1 AND finished_at IS NOT NULL AND target_key NOT IN ('file','run','lineage') ORDER BY started_at DESC LIMIT 1000) a
      GROUP BY stage`,
            [run],
          )
        ).rows
      : [];
    const legacy = run
      ? (
          await client.query(
            `SELECT count(*)::int AS requests,round(avg(latency_ms))::int AS mean_latency_ms,
      round(avg(completion_tokens))::int AS mean_completion_tokens,sum(estimated_cost_usd)::float AS known_cost_usd
      FROM (SELECT * FROM research_normalization_requests WHERE run_id=$1 AND provider_call_id IS NULL ORDER BY created_at DESC LIMIT 1000) q`,
            [run],
          )
        ).rows[0]
      : null;
    const quota = run
      ? (
          await client.query(
            `SELECT provider,operation,http_status,quota,concurrency,started_at FROM research_ingest_provider_calls
      WHERE run_id=$1 ORDER BY started_at DESC LIMIT 5`,
            [run],
          )
        ).rows
      : [];
    const current = executions[0],
      concurrency =
        current?.scheduler_version === 2
          ? (current.options.llmConcurrency ?? 4)
          : 1;
    const file = inventory.files.find(
      (f) => f.logical_path === current?.logical_path,
    );
    const remaining = file ? Math.max(0, file.records - file.normalized) : 0;
    const classified = inventory.files.filter(
      (f) => f.disposition === "import",
    );
    const summary = {
      discovered: inventory.files.length,
      intended: classified.length,
      complete: classified.filter((f) => f.coverage === "complete").length,
      active: classified.filter((f) => f.execution === "running").length,
      partial: classified.filter(
        (f) => f.coverage === "partial" && f.execution !== "running",
      ).length,
      unstarted: classified.filter((f) => f.coverage === "unstarted").length,
      review: inventory.files.filter((f) => f.disposition === "needs_review")
        .length,
      excluded: inventory.files.filter(
        (f) => !["import", "needs_review"].includes(f.disposition),
      ).length,
      degraded_records: classified.reduce((n, f) => n + f.degraded, 0),
    };
    const catalog = await expectedCaptures();
    const reviews = (
      await client.query(
        `SELECT DISTINCT ON(inventory_id) inventory_id,decision,reason,sample_records,reviewed_at FROM research_ingest_quality_reviews q
      JOIN research_ingest_inventory i ON i.id=q.inventory_id AND i.file_sha256=q.file_sha256 WHERE q.pipeline_versions=$1::jsonb ORDER BY inventory_id,reviewed_at DESC`,
        [JSON.stringify(PIPELINE_VERSIONS)],
      )
    ).rows;
    const quality = new Map(reviews.map((r) => [r.inventory_id, r]));
    const category_coverage = [
      ...new Set(catalog.filter((c) => c.required).map((c) => c.category)),
    ]
      .map((category) => {
        const required = catalog.filter(
          (c) =>
            c.required &&
            c.category === category &&
            (!options.file || c.file === options.file),
        );
        const known = required.map((c) =>
          inventory.files.find((f) => f.logical_path === c.file),
        );
        return {
          category,
          filtered: Boolean(options.file),
          expected_files: required.length,
          missing: known.filter((f) => !f || f.missing_at).length,
          structural_complete: known.filter((f) => f?.coverage === "complete")
            .length,
          quality_reviewed: known.filter(
            (f) => f && quality.get(f.id)?.decision === "accepted",
          ).length,
          complete:
            required.length > 0 &&
            known.every(
              (f) =>
                f?.coverage === "complete" &&
                quality.get(f.id)?.decision === "accepted",
            ),
        };
      })
      .filter((c) => c.expected_files > 0);
    const queue = buildImportQueue(inventory, control);
    const interventions: any[] = issues.map((x) => ({
      ...x,
      inspect_args: ["ingest:doctor", "--run", x.run_id, "--json"],
    }));
    for (const w of control.workers) {
      if (w.heartbeat_stale)
        interventions.push({
          code: "heartbeat_stale",
          scope: "source",
          severity: "blocking",
          run_id: w.run_id,
          execution_id: w.execution_id,
          message:
            "Inspect process, lock and committed progress; staleness is not proof of death",
        });
      if (w.local_process === "remote_unknown")
        interventions.push({
          code: "identity_unknown",
          scope: "source",
          severity: "warning",
          run_id: w.run_id,
          message: "Host identity is unknown; do not signal a saved PID",
        });
      if (
        !local.jobs.some(
          (j) => j.run_id === w.run_id && j.execution_id === w.execution_id,
        )
      )
        interventions.push({
          code: "job_evidence_missing",
          scope: "source",
          severity: "warning",
          run_id: w.run_id,
          message:
            "Database worker lacks matching local supervisor evidence; inspect its host",
        });
    }
    for (const capture of catalog.filter((c) => c.required)) {
      const actual = inventory.files.find(
        (f) => f.logical_path === capture.file,
      );
      if (options.file && capture.file !== options.file) continue;
      if (!actual || actual.missing_at)
        interventions.push({
          code: "expected_capture_missing",
          scope: "file",
          severity: "blocking",
          file: capture.file,
          message:
            "Required capture missing; restore or record a reviewed replacement",
        });
      else if (
        actual.category_slug !== capture.category ||
        actual.disposition !== "import"
      )
        interventions.push({
          code: "catalog_classification_mismatch",
          scope: "file",
          severity: "warning",
          file: capture.file,
          message:
            "Reconcile audited inventory classification with the expected-source catalog",
        });
    }
    const cooldown = quota.find(
      (q) =>
        q.concurrency?.cooldown_until &&
        Date.parse(q.concurrency.cooldown_until) > Date.now(),
    );
    if (cooldown)
      interventions.push({
        code: "provider_cooldown",
        scope: "source",
        severity: "info",
        provider: cooldown.provider,
        retry_at: cooldown.concurrency.cooldown_until,
        message:
          "Ordinary provider recovery owns waiting; do not relaunch this worker",
      });
    if (local.errors.length)
      interventions.push({
        code: "local_evidence_unknown",
        scope: "global",
        severity: "blocking",
        message: local.errors.join("; "),
      });
    if (local.claims.length)
      interventions.push({
        code: "launch_unresolved",
        scope: "global",
        severity: "blocking",
        message: "Reconcile launch intents before another start",
        evidence: local.claims,
      });
    const decision = control.maintenance.maintenance
      ? { action: "maintenance", reason: control.maintenance.reason }
      : interventions.some(
            (x) => x.scope === "global" && x.severity === "blocking",
          )
        ? { action: "inspect", reason: "Unresolved global evidence" }
        : control.workers.length
          ? {
              action: "wait_for_active_run",
              run_id: control.workers[0].run_id,
              reason:
                "Supervisor owns execution; inspect listed interventions separately",
            }
          : queue.admission.launch_allowed
            ? { action: queue.next?.action ?? "none", item: queue.next }
            : { action: "inspect", reason: queue.admission.reason };
    data = {
      schema_version: 1,
      observed_at: new Date().toISOString(),
      components: {
        database: { status: "available", observed_at: inventory.inspectedAt },
        local,
      },
      summary,
      control,
      decision,
      interventions,
      improvements: performanceOpportunities(
        metrics.length ? metrics : [{ operation: "normalize", ...legacy }],
        concurrency,
        remaining,
      ),
      execution: current ?? null,
      tasks,
      task_metrics,
      file_count: inventory.files.length,
      file_page: {
        offset: options.offset ?? 0,
        limit: options.limit ?? 20,
        total: inventory.files.length,
      },
      metrics_scope: "latest 1000 attributed calls / completed record attempts",
      provider_metrics: metrics,
      legacy_normalization_metrics: legacy,
      provider_limits: quota,
      scans,
      category_coverage,
      quality_reviews: reviews,
      files: inventory.files
        .slice(
          options.offset ?? 0,
          (options.offset ?? 0) + (options.limit ?? 20),
        )
        .map((f) => ({
          id: f.id,
          file: f.logical_path,
          source: f.source_slug,
          category: f.category_slug,
          disposition: f.disposition,
          coverage: f.coverage,
          execution: f.execution,
          freshness: f.freshness,
          total: f.total,
          normalized: f.normalized,
          embedded: f.embedded,
          linked: f.linked,
          verified: f.verified,
          excluded: f.excluded,
          degraded: f.degraded,
          scanned_at: f.scanned_at,
          next: f.next,
          commands: f.commands,
          quality: quality.get(f.id)?.decision ?? "unreviewed",
        })),
    };
    if (options.includeInventory) data.inventory = inventory;
    if (options.detail && run)
      data.recent_attempts = (
        await client.query(
          `SELECT id,execution_id,stage,target_key,status,started_at,finished_at,input,output,error FROM research_ingest_attempts WHERE run_id=$1 ORDER BY started_at DESC LIMIT 20`,
          [run],
        )
      ).rows;
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    data = {
      schema_version: 1,
      observed_at: new Date().toISOString(),
      components: {
        database: {
          status: "unknown",
          message: error instanceof Error ? error.message : String(error),
        },
        local,
      },
      decision: {
        action: "inspect",
        reason: "Database evidence unavailable; no launch is recommended",
      },
      interventions: [
        {
          code: "database_evidence_unknown",
          scope: "global",
          severity: "blocking",
        },
      ],
      improvements: [],
      summary: null,
      files: [],
    };
  } finally {
    client.release();
  }
  assertOverview(data);
  return data;
}
