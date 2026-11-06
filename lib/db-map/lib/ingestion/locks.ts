/** Database-wide lock allocation. Two-int keys never overlap bigint keys. */
export const INGEST_LOCK_NAMESPACE = 91832;
export const INVENTORY_SCAN_LOCK = 3;
export const CANONICAL_WRITER_LOCK = 0x5018a;
/** Held for its lifetime by the one import-queue worker (ingest:import-queue), on any host. */
export const IMPORT_QUEUE_LOCK = 4;
/** Set by the queue on the imports it launches; other full imports wait for the queue. */
export const IMPORT_QUEUE_ENV = "INGEST_IMPORT_QUEUE_ID";

/**
 * Whether an import-queue worker (any host) holds the queue lock exclusively in this database.
 * Plain full imports hold the same key in shared mode, so the two can never be admitted together.
 */
/** The queue id whose worker holds the queue lock (its connection's application_name). */
export async function importQueueLockHolder(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ name: string | null }> }>;
}): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT a.application_name AS name FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
     WHERE l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock'
       AND l.classid=$1::int::oid AND l.objid=$2::int::oid AND l.objsubid=2
       AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
     LIMIT 1`,
    [INGEST_LOCK_NAMESPACE, IMPORT_QUEUE_LOCK],
  );
  const name = rows[0]?.name ?? null;
  return name?.startsWith("import-queue:") ? name.slice("import-queue:".length) : name;
}

export async function importQueueActive(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ held: boolean }> }>;
}): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
       AND mode='ExclusiveLock' AND classid=$1::int::oid AND objid=$2::int::oid AND objsubid=2
       AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) AS held`,
    [INGEST_LOCK_NAMESPACE, IMPORT_QUEUE_LOCK],
  );
  return !!rows[0]?.held;
}
/** Held exclusively for its whole run by every full-scope import (plain or queued), any host. */
export const FULL_IMPORT_LOCK = 5;
