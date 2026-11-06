/**
 * Live monitor for the ingestion dashboard: the latest run's per-stage progress, throughput and
 * ETA, today's geocoding quota, and published data quality (location precision, review flags,
 * unlocated and failed records). Read-only and bounded; one REPEATABLE READ snapshot.
 */
import type { Pool } from "pg";
import { providerUsageToday, type ProviderUsageToday } from "../scripts/ingest/providers/quota.js";
import { RECORD_STAGES } from "./ingestion-tasks.js";

const DONE = ["succeeded", "reused", "skipped"];
/** Throughput window for rates and ETAs. */
const WINDOW_MINUTES = 15;

export interface StageProgress {
  stage: string;
  total: number;
  done: number;
  running: number;
  pending: number;
  waiting_budget: number;
  quarantined: number;
  other: number;
  /** Records finished per minute over the last WINDOW_MINUTES. */
  per_minute: number;
  eta_minutes: number | null;
}

export interface RunProgress {
  run_id: string;
  source: string;
  file: string | null;
  category: string;
  status: string;
  stop_reason: string | null;
  current_stage: string | null;
  started_at: string | null;
  heartbeat_at: string | null;
  verified_at: string | null;
  records: number;
  stages: StageProgress[];
  /** The slowest remaining stage bounds the whole file. */
  eta_minutes: number | null;
  provider_quota: Record<string, unknown> | null;
}

export interface SourceQuality {
  source: string;
  records: number;
  non_poi: number;
  normalization_failed: number;
  degraded: number;
  unlocated: number;
  published_pois: number;
}

export interface IngestionMonitor {
  observed_at: string;
  window_minutes: number;
  run: RunProgress | null;
  quota: ProviderUsageToday | null;
  quality: {
    published_pois: number;
    hidden_pois: number;
    precise_pois: number;
    general_pois: number;
    review_flags: Record<string, number>;
    research_records: number;
    unlocated_records: number;
    normalization_failed: number;
    degraded: number;
    by_source: SourceQuality[];
  };
}

export function stageProgress(
  stage: string,
  counts: Array<{ state: string; records: number }>,
  finishedInWindow: number,
): StageProgress {
  const sum = (states: string[]) =>
    counts.filter((c) => states.includes(c.state)).reduce((n, c) => n + c.records, 0);
  const total = counts.reduce((n, c) => n + c.records, 0);
  const done = sum(DONE);
  const running = sum(["running"]);
  const pending = sum(["pending", "paused", "retryable", "blocked"]);
  const waiting = sum(["waiting_budget"]);
  const quarantined = sum(["quarantined"]);
  const perMinute = finishedInWindow / WINDOW_MINUTES;
  const remaining = total - done - quarantined;
  return {
    stage,
    total,
    done,
    running,
    pending,
    waiting_budget: waiting,
    quarantined,
    other: total - done - running - pending - waiting - quarantined,
    per_minute: Math.round(perMinute * 10) / 10,
    eta_minutes: remaining <= 0 ? 0 : perMinute > 0 ? Math.ceil(remaining / perMinute) : null,
  };
}

const QUALITY_SOURCES_SQL = `
  WITH r AS (
    SELECT rp.id, rp.source_id, rp.is_poi, rp.normalization_state, rp.lat, rp.attributes, m.canonical_poi_id
    FROM research_pois rp
    LEFT JOIN research_canonical_memberships m ON m.research_poi_id = rp.id AND m.active
    WHERE rp.retired_at IS NULL)
  SELECT s.slug AS source, count(r.id)::int AS records,
    count(r.id) FILTER (WHERE r.is_poi = false)::int AS non_poi,
    count(r.id) FILTER (WHERE r.normalization_state IN ('failed','active_stale'))::int AS normalization_failed,
    count(r.id) FILTER (WHERE r.normalization_state = 'degraded')::int AS degraded,
    count(r.id) FILTER (WHERE r.attributes ? 'location_unresolved' AND r.lat IS NULL)::int AS unlocated,
    count(DISTINCT cp.id) FILTER (WHERE cp.status='published')::int AS published_pois
  FROM research_sources s
  JOIN r ON r.source_id = s.id
  LEFT JOIN canonical_pois cp ON cp.id = r.canonical_poi_id
  GROUP BY s.slug ORDER BY records DESC`;

/**
 * Published-data quality: whole-table aggregates, so callers should cache it (the dashboard
 * refreshes it at most every two minutes). Totals cover every source; the table lists the
 * 50 largest.
 */
export async function getQualityMonitor(db: Pool): Promise<IngestionMonitor["quality"]> {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='20s'");
    const q = (
      await client.query(
        `SELECT
          count(*) FILTER (WHERE status='published')::int AS published,
          count(*) FILTER (WHERE status<>'published')::int AS hidden,
          count(*) FILTER (WHERE status='published' AND attributes->>'location_specificity'='general')::int AS general
         FROM canonical_pois`,
      )
    ).rows[0];
    const flags = (
      await client.query(
        `SELECT flag, count(*)::int AS pois FROM canonical_pois, unnest(review_flags) flag
         WHERE status='published' GROUP BY flag ORDER BY flag`,
      )
    ).rows;
    const sources = (await client.query(QUALITY_SOURCES_SQL)).rows as SourceQuality[];
    await client.query("COMMIT");
    const total = (k: keyof SourceQuality) => sources.reduce((n, s) => n + Number(s[k] ?? 0), 0);
    return {
      published_pois: q.published,
      hidden_pois: q.hidden,
      precise_pois: q.published - q.general,
      general_pois: q.general,
      review_flags: Object.fromEntries(flags.map((f) => [f.flag, f.pois])),
      research_records: total("records"),
      unlocated_records: total("unlocated"),
      normalization_failed: total("normalization_failed"),
      degraded: total("degraded"),
      by_source: sources.slice(0, 50),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Run progress and quota (cheap; per-run task counts). Quality comes from getQualityMonitor. */
export async function getIngestionMonitor(
  db: Pool,
  quality?: IngestionMonitor["quality"],
): Promise<IngestionMonitor> {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout='10s'");
    const run = (
      await client.query(
        `SELECT r.id, s.slug AS source, f.logical_path AS file, r.category_slug, r.status, r.stop_reason,
           r.current_stage, r.started_at, r.heartbeat_at, r.verified_at, r.counters->'providerQuota' AS provider_quota,
           (SELECT count(*)::int FROM research_ingest_run_items WHERE run_id=r.id) AS records
         FROM research_ingest_runs r
         JOIN research_sources s ON s.id=r.source_id
         LEFT JOIN research_source_file_versions v ON v.id=r.source_file_version_id
         LEFT JOIN research_source_files f ON f.id=v.source_file_id
         WHERE r.started_at IS NOT NULL
         ORDER BY (r.status='running') DESC, COALESCE(r.heartbeat_at, r.started_at) DESC LIMIT 1`,
      )
    ).rows[0];
    let progress: RunProgress | null = null;
    if (run) {
      const { rows } = await client.query(
        `SELECT stage, state, count(*)::int AS records,
           count(*) FILTER (WHERE state = ANY($2::text[]) AND finished_at > now() - make_interval(mins => $3))::int AS recent
         FROM research_ingest_tasks WHERE run_id=$1 GROUP BY stage, state`,
        [run.id, DONE, WINDOW_MINUTES],
      );
      const stages = (RECORD_STAGES as readonly string[])
        .filter((stage) => rows.some((r) => r.stage === stage))
        .map((stage) => {
          const mine = rows.filter((r) => r.stage === stage);
          return stageProgress(
            stage,
            mine,
            mine.reduce((n, r) => n + r.recent, 0),
          );
        });
      const etas = stages.map((s) => s.eta_minutes);
      progress = {
        run_id: run.id,
        source: run.source,
        file: run.file,
        category: run.category_slug,
        status: run.status,
        stop_reason: run.stop_reason,
        current_stage: run.current_stage,
        started_at: run.started_at?.toISOString?.() ?? run.started_at,
        heartbeat_at: run.heartbeat_at?.toISOString?.() ?? run.heartbeat_at,
        verified_at: run.verified_at?.toISOString?.() ?? run.verified_at,
        records: run.records,
        stages,
        eta_minutes:
          run.status !== "running" || etas.includes(null)
            ? null
            : Math.max(0, ...(etas as number[])),
        provider_quota: run.provider_quota,
      };
    }
    await client.query("COMMIT");
    let quota: ProviderUsageToday | null = null;
    try {
      quota = await providerUsageToday(db);
    } catch {
      quota = null;
    }
    return {
      observed_at: new Date().toISOString(),
      window_minutes: WINDOW_MINUTES,
      run: progress,
      quota,
      quality: quality ?? (await getQualityMonitor(db)),
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
