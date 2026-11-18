import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import {
  IMPORT_QUEUE_LOCK,
  IMPORT_QUEUE_PRESENCE_LOCK,
  INGEST_LOCK_NAMESPACE,
} from "../lib/ingestion/locks.js";
import type { QueueEntry, QueueState } from "../scripts/ingest/import-queue.js";
import type { inspectControl } from "../scripts/ingest/control.js";
import { UUID, type Job } from "../scripts/ingest/supervisor-state.js";
import { PIPELINE_VERSIONS } from "../scripts/ingest/pipeline-versions.js";

type Control = Awaited<ReturnType<typeof inspectControl>>;
type Journal = {
  id: string;
  status: Job["status"];
  run_id: string | null;
  execution_id: string | null;
  host: string;
  host_id: string | null;
  supervisor_pid?: number;
  child_pid?: number;
  started_at: string;
  last_health_at: string | null;
  last_health_evidence: Record<string, unknown> | null;
  result: { outcome: string | null; exit_code: number | null } | null;
  journal: string;
};
type ExecutionReceipt = {
  execution_id: string;
  run_id: string;
  status: string;
  stop_reason: string | null;
  finished_at: Date | null;
  run_verified_at: Date | null;
  file: string;
};

async function readJournals<T extends object>(
  directory: string,
  filename: string,
  project: (value: T, path: string) => T,
) {
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      errors.push(`Cannot read ${filename} journals`);
    }
    return { values: [], errors };
  }
  const values: T[] = [];
  for (const id of entries.filter((id) => UUID.test(id))) {
    const path = join(directory, id, filename);
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value?.id !== id) throw new Error("Journal identity mismatch");
      values.push(project(value, path));
    } catch {
      errors.push(`Unreadable ${filename} journal ${id}`);
    }
  }
  return { values, errors };
}

export async function readOverviewJournals(root: string) {
  const observed_at = new Date().toISOString();
  const pkg = join(root, "lib/db-map");
  const [jobs, queues] = await Promise.all([
    readJournals<Journal>(
      join(pkg, ".ingest-jobs"),
      "job.json",
      (job, journal) => ({
        id: job.id,
        status: job.status,
        run_id: job.run_id ?? null,
        execution_id: job.execution_id ?? null,
        host: job.host,
        host_id: job.host_id ?? null,
        supervisor_pid: job.supervisor_pid,
        child_pid: job.child_pid,
        started_at: job.started_at,
        last_health_at: job.last_health_at ?? null,
        last_health_evidence: job.last_health_evidence ?? null,
        result: job.result
          ? {
              outcome: job.result.outcome ?? null,
              exit_code: job.result.exit_code ?? null,
            }
          : null,
        journal,
      }),
    ),
    readJournals<QueueState>(
      join(pkg, ".ingest-queues"),
      "state.json",
      (queue) => {
        if (
          !Array.isArray(queue.entries) ||
          typeof queue.created_at !== "string" ||
          queue.entries.some((entry) => !entry || !Array.isArray(entry.jobs))
        ) {
          throw new Error("Invalid queue journal");
        }
        return queue;
      },
    ),
  ]);
  return {
    observed_at,
    journals: jobs.values,
    queues: queues.values.sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    ),
    errors: [...jobs.errors, ...queues.errors],
  };
}

export function assessWorkers(control: Control) {
  const admitted = new Set(
    control.admitted_workers.map((lock) => lock.database_pid),
  );
  const locked = new Set(
    control.source_locks
      .filter((lock) => admitted.has(lock.database_pid))
      .map((lock) => lock.source),
  );
  // The lock identifies a source. Multiple fresh rows can survive a change of worker.
  const freshBySource = new Map<string, number>();
  for (const worker of control.workers.filter((w) => w.heartbeat_stale === false)) {
    freshBySource.set(
      worker.source,
      (freshBySource.get(worker.source) ?? 0) + 1,
    );
  }
  const workers = control.workers.map((worker) => {
    const confirmed =
      worker.heartbeat_stale === false &&
      locked.has(worker.source) &&
      freshBySource.get(worker.source) === 1 &&
      (worker.identity_verified || worker.local_process === "remote_unknown");
    return {
      ...worker,
      liveness: confirmed ? ("confirmed" as const) : ("unconfirmed" as const),
    };
  });
  const confirmed = workers.filter(
    (worker) => worker.liveness === "confirmed",
  ).length;
  return { confirmed, unconfirmed: workers.length - confirmed, workers };
}

export function assessJournals(
  journals: Journal[],
  workers: ReturnType<typeof assessWorkers>["workers"],
  evidence: ExecutionReceipt[],
) {
  return journals
    .filter((job) => job.status !== "finished")
    .map((job) => {
      const execution = evidence.find(
        (row) =>
          row.execution_id === job.execution_id && row.run_id === job.run_id,
      );
      const worker = workers.find(
        (row) =>
          row.execution_id === job.execution_id && row.run_id === job.run_id,
      );
      const assessment =
        execution && execution.status !== "running"
          ? "terminal_execution"
          : worker?.liveness === "confirmed"
            ? "confirmed_active"
            : "unconfirmed";
      return {
        ...job,
        assessment,
        execution_status: execution?.status ?? worker?.status ?? null,
        execution_finished_at: execution?.finished_at ?? null,
      };
    });
}

const receiptSelect = `SELECT e.id AS execution_id,e.run_id,e.status,e.stop_reason,e.finished_at,
  r.verified_at AS run_verified_at,f.logical_path AS file
  FROM research_ingest_executions e JOIN research_ingest_runs r ON r.id=e.run_id
  JOIN research_source_file_versions v ON v.id=r.source_file_version_id
  JOIN research_source_files f ON f.id=v.source_file_id`;

export async function readExecutionReceipts(
  client: PoolClient,
  journals: Journal[],
  run?: string,
  file?: string,
) {
  const unresolved = journals
    .filter(
      (job) =>
        job.status !== "finished" &&
        job.execution_id &&
        UUID.test(job.execution_id),
    )
    .map((job) => job.execution_id);
  const exact = unresolved.length
    ? (
        await client.query<ExecutionReceipt>(
          `${receiptSelect} WHERE e.id=ANY($1::uuid[]) ORDER BY e.id`,
          [unresolved],
        )
      ).rows
    : [];
  const recent = (
    await client.query<ExecutionReceipt>(
      `${receiptSelect} WHERE e.finished_at IS NOT NULL AND e.status<>'running'
      AND ($1::uuid IS NULL OR e.run_id=$1) AND ($2::text IS NULL OR f.logical_path=$2)
      ORDER BY e.finished_at DESC,e.id DESC LIMIT 8`,
      [run ?? null, file ?? null],
    )
  ).rows;
  return { exact, recent };
}

type QueueLocks = { held: boolean; holder: string | null };
export async function readQueueLocks(client: PoolClient): Promise<QueueLocks> {
  const { rows } = await client.query<{ name: string | null }>(
    `SELECT a.application_name AS name FROM pg_locks l LEFT JOIN pg_stat_activity a USING(pid)
     WHERE l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock'
       AND l.classid=$1::int::oid AND l.objid IN ($2::int::oid,$3::int::oid) AND l.objsubid=2
       AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
    [INGEST_LOCK_NAMESPACE, IMPORT_QUEUE_PRESENCE_LOCK, IMPORT_QUEUE_LOCK],
  );
  const names = new Set(
    rows.map((row) => row.name?.replace(/^import-queue:/, "")),
  );
  const name = [...names][0];
  return {
    held: rows.length > 0,
    holder: names.size === 1 && name && UUID.test(name) ? name : null,
  };
}

export function assessQueue(
  queues: QueueState[],
  locks: QueueLocks,
  journals: Journal[],
  workers: ReturnType<typeof assessWorkers>["workers"],
  coverage: ReadonlyMap<string, string>,
  now = Date.now(),
) {
  const waiting = queues.find(
    (queue) =>
      queue.status === "queued" && now - Date.parse(queue.updated_at) < 120_000,
  );
  const queue = locks.held
    ? queues.find((item) => item.id === locks.holder)
    : (waiting ?? queues[0]);
  const active = locks.held || Boolean(waiting);
  const describe = (entry: QueueEntry) => {
    const job_id = entry.jobs.at(-1) ?? null;
    const job = journals.find((item) => item.id === job_id);
    const worker = workers.find(
      (item) =>
        item.execution_id === job?.execution_id && item.run_id === job?.run_id,
    );
    return {
      file: entry.file,
      category: entry.category,
      status: entry.status,
      outcome: entry.outcome,
      recorded_coverage: entry.coverage,
      current_coverage: coverage.get(entry.file) ?? null,
      run_id: job?.run_id ?? entry.run_id,
      execution_id: job?.execution_id ?? null,
      job_id,
      worker_confirmed: worker?.liveness === "confirmed",
      finished_at: entry.finished_at,
      stop_reason: entry.reason,
      resumes_at: entry.resets_at,
    };
  };
  const current = queue?.entries[queue.current ?? -1];
  return {
    active,
    evidence: locks.held
      ? "lock"
      : waiting
        ? "starting"
        : queue
          ? "journal_only"
          : "none",
    id: queue?.id ?? locks.holder,
    recorded_status: queue?.status ?? null,
    journal_available: Boolean(queue),
    updated_at: queue?.updated_at ?? null,
    message: queue?.message ?? null,
    counts: queue
      ? queue.entries.reduce<Record<string, number>>((counts, entry) => {
          counts[entry.status] = (counts[entry.status] ?? 0) + 1;
          return counts;
        }, {})
      : null,
    current: current ? describe(current) : null,
    recent_finished: queue
      ? queue.entries
          .filter((entry) => entry.finished_at)
          .sort((a, b) =>
            (b.finished_at ?? "").localeCompare(a.finished_at ?? ""),
          )
          .slice(0, 8)
          .map(describe)
      : [],
  } as const;
}

export async function currentCapturePresence(root: string, file: string) {
  try {
    const stat = await lstat(join(root, file));
    return stat.isFile() ? "present" : "missing";
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes(
      (error as NodeJS.ErrnoException).code ?? "",
    )
      ? "missing"
      : "unknown";
  }
}

export async function readCoverageChanges(client: PoolClient, files: string[]) {
  if (!files.length) return [];
  // Compare current outputs against the latest compatible whole-file verification. A bounded
  // run's proof cannot explain why a previously verified whole capture needs rechecking.
  return (
    await client.query<{
      file: string;
      verification_at: Date;
      run_id: string;
      newer_canonical_build_records: number;
      latest_build_at: Date | null;
      newer_record_artifact_records: number;
    }>(
      `WITH baseline AS (
    SELECT DISTINCT ON (i.logical_path) i.logical_path AS file,r.id AS run_id,r.verified_at
    FROM research_ingest_inventory i
    JOIN research_source_files f ON f.logical_path=i.logical_path AND f.category_slug=i.category_slug
    JOIN research_sources s ON s.id=f.source_id AND s.slug=i.source_slug
    JOIN research_source_file_versions v ON v.source_file_id=f.id
      AND v.file_sha256=i.file_sha256 AND v.extractor_version=i.extractor_version
    JOIN research_ingest_runs r ON r.source_file_version_id=v.id AND r.category_slug=i.category_slug
    WHERE i.logical_path=ANY($1::text[]) AND r.managed AND r.status='succeeded' AND r.verified_at IS NOT NULL
      AND r.options->>'record' IS NULL AND r.options->>'limit' IS NULL
      AND COALESCE((r.options->>'shadow')::boolean,false)=false
      AND COALESCE(r.counters->'verification'->'pipeline_versions',r.pipeline_versions)=$2::jsonb
    ORDER BY i.logical_path,r.verified_at DESC,r.id DESC
  )
  SELECT b.file,b.run_id,b.verified_at AS verification_at,
    count(*) FILTER (WHERE cb.activated_at>b.verified_at)::int AS newer_canonical_build_records,
    max(cb.activated_at) FILTER (WHERE cb.activated_at>b.verified_at) AS latest_build_at,
    count(*) FILTER (WHERE greatest(n.activated_at,g.activated_at,em.activated_at)>b.verified_at)::int
      AS newer_record_artifact_records
  FROM baseline b JOIN research_ingest_run_items ri ON ri.run_id=b.run_id
  JOIN research_pois rp ON rp.id=ri.research_poi_id AND rp.active_observation_id=ri.observation_id AND rp.retired_at IS NULL
  LEFT JOIN research_poi_normalizations n ON n.id=rp.active_normalization_id
  LEFT JOIN research_poi_geocodes g ON g.id=rp.active_geocode_id
  LEFT JOIN research_poi_embeddings em ON em.id=rp.active_embedding_id
  LEFT JOIN research_canonical_memberships m ON m.research_poi_id=rp.id AND m.active
    AND m.normalization_id=n.id AND m.canonical_poi_id=rp.canonical_poi_id
  LEFT JOIN canonical_pois cp ON cp.id=m.canonical_poi_id
  LEFT JOIN canonical_poi_builds cb ON cb.id=cp.active_build_id
  GROUP BY b.file,b.run_id,b.verified_at`,
      [files, JSON.stringify(PIPELINE_VERSIONS)],
    )
  ).rows;
}
