import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

// Two-int advisory keys are disjoint from the existing bigint source-lock keys.
// (91832, 1): shared for the full worker lifetime; exclusive for drain verification.
// (91832, 2): transaction mutex serializing admission and maintenance changes.
export async function controlMutex(client: PoolClient) {
  await client.query("SELECT pg_advisory_xact_lock(91832,2)");
}

export async function controlState(db: Pool | PoolClient) {
  const { rows } = await db.query(
    "SELECT * FROM research_ingest_control WHERE singleton",
  );
  if (!rows[0]) throw new Error("Missing ingestion control row; run db:sync");
  return rows[0];
}

export async function admitWorker(client: PoolClient) {
  await controlMutex(client);
  const state = await controlState(client);
  if (state.maintenance)
    throw new Error(
      `Ingestion maintenance is enabled: ${state.reason}. Inspect ingest:control list before starting work.`,
    );
  await client.query("SELECT pg_advisory_lock_shared(91832,1)");
}

export async function changeMaintenance(
  db: Pool,
  enabled: boolean,
  actor: string,
  reason?: string,
  token?: string,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await controlMutex(client);
    const previous = await controlState(client);
    if (enabled && previous.maintenance)
      throw new Error(
        `Maintenance already enabled by ${previous.actor}: ${previous.reason}. Inspect ingest:control list; do not replace another operator's gate.`,
      );
    if (
      !enabled &&
      (!previous.maintenance || previous.maintenance_token !== token)
    )
      throw new Error(
        "Maintenance exit requires the current maintenance token",
      );
    const nextToken = enabled ? randomUUID() : null;
    await client.query(
      `UPDATE research_ingest_control SET maintenance=$1,maintenance_token=$2,reason=$3,actor=$4,updated_at=now() WHERE singleton`,
      [enabled, nextToken, reason ?? previous.reason, actor],
    );
    if (enabled)
      await client.query(
        "UPDATE research_ingest_runs SET stop_requested=true WHERE managed AND status='running'",
      );
    await client.query(
      "INSERT INTO research_ingest_control_events(action,actor,details) VALUES($1,$2,$3)",
      [
        enabled ? "maintenance_enter" : "maintenance_exit",
        actor,
        JSON.stringify({
          reason: reason ?? previous.reason,
          token: nextToken ?? token,
        }),
      ],
    );
    await client.query("COMMIT");
    return await controlState(client);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function requestStops(
  db: Pool,
  run: string | undefined,
  actor: string,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE research_ingest_runs SET stop_requested=true
      WHERE managed AND status='running' AND ($1::uuid IS NULL OR id=$1) RETURNING id`,
      [run ?? null],
    );
    if (run && !rows.length) {
      const existing = await client.query(
        "SELECT id FROM research_ingest_runs WHERE id=$1 AND managed",
        [run],
      );
      if (!existing.rowCount) throw new Error("Unknown managed run");
    }
    await client.query(
      "INSERT INTO research_ingest_control_events(action,actor,details) VALUES('stop_requested',$1,$2)",
      [
        actor,
        JSON.stringify({ scope: run ?? "all", runs: rows.map((r) => r.id) }),
      ],
    );
    await client.query("COMMIT");
    return rows.map((r) => r.id as string);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function workerEvidence(db: Pool) {
  const workers = (
    await db.query(`SELECT e.id AS execution_id,e.run_id,e.host,e.pid,e.status,
      e.started_at,e.heartbeat_at,r.current_stage,r.stop_requested,s.slug AS source,
      (e.heartbeat_at < now()-interval '30 seconds') AS heartbeat_stale
    FROM research_ingest_executions e JOIN research_ingest_runs r ON r.id=e.run_id
    JOIN research_sources s ON s.id=r.source_id WHERE e.status='running'
    ORDER BY e.started_at`)
  ).rows;
  const sourceLocks = (
    await db.query(`SELECT s.slug AS source,l.pid AS database_pid
    FROM research_sources s JOIN pg_locks l ON l.locktype='advisory' AND l.granted AND l.objsubid=1
      AND l.classid=((hashtextextended(s.slug,91831)>>32)&4294967295)::oid
      AND l.objid=(hashtextextended(s.slug,91831)&4294967295)::oid
    WHERE l.database=(SELECT oid FROM pg_database WHERE datname=current_database())`)
  ).rows;
  const admitted = (
    await db.query(`SELECT pid AS database_pid FROM pg_locks
    WHERE locktype='advisory' AND granted AND classid=91832 AND objid=1 AND objsubid=2
    AND mode='ShareLock' AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`)
  ).rows;
  return { workers, sourceLocks, admitted };
}

/** Caller must first verify the recorded local process is absent. Keep all failure evidence. */
export async function reconcileAbsentExecution(
  db: Pool,
  executionId: string,
  actor: string,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await controlMutex(client);
    if (!(await controlState(client)).maintenance)
      throw new Error("Reconciliation requires maintenance mode");
    const e = (
      await client.query(
        `SELECT e.*,s.slug FROM research_ingest_executions e
      JOIN research_ingest_runs r ON r.id=e.run_id JOIN research_sources s ON s.id=r.source_id
      WHERE e.id=$1 AND e.status='running' FOR UPDATE OF e`,
        [executionId],
      )
    ).rows[0];
    if (!e)
      throw new Error(
        "Execution is no longer recorded as running; inspect again",
      );
    const lock = (
      await client.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended($1,91831)) AS acquired",
        [e.slug],
      )
    ).rows[0];
    if (!lock.acquired)
      throw new Error("Source still locked; cannot reconcile");
    const active = (
      await client.query(
        "SELECT pg_try_advisory_xact_lock(91832,1) AS acquired",
      )
    ).rows[0];
    if (!active.acquired)
      throw new Error(
        "An admitted worker is still active; wait before reconciliation",
      );
    await client.query(
      `UPDATE research_ingest_attempts SET status='interrupted',finished_at=now(),
      error=jsonb_build_object('message','Local process absent and source lock released; termination cause unknown')
      WHERE execution_id=$1 AND status='running'`,
      [e.id],
    );
    await client.query(
      `UPDATE research_ingest_executions SET status='interrupted',finished_at=now(),
      stop_reason='operator_reconciled_absent_worker' WHERE id=$1`,
      [e.id],
    );
    await client.query(
      `UPDATE research_ingest_runs SET status='paused',stop_requested=true,
      stop_reason='operator_reconciled_absent_worker',stopped_at=now()
      WHERE id=$1 AND status='running' AND NOT EXISTS(SELECT 1 FROM research_ingest_executions WHERE run_id=$1 AND status='running')`,
      [e.run_id],
    );
    await client.query(
      "INSERT INTO research_ingest_control_events(action,actor,details) VALUES('reconcile_absent_worker',$1,$2)",
      [
        actor,
        JSON.stringify({
          execution_id: e.id,
          run_id: e.run_id,
          host: e.host,
          pid: e.pid,
        }),
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
