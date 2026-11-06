/** Database-wide lock allocation. Two-int keys never overlap bigint keys. */
export const INGEST_LOCK_NAMESPACE = 91832;
export const INVENTORY_SCAN_LOCK = 3;
export const CANONICAL_WRITER_LOCK = 0x5018a;
/** Held for its lifetime by the one import-queue worker (ingest:import-queue), on any host. */
export const IMPORT_QUEUE_LOCK = 4;
/** Set by the queue on the imports it launches; other full imports wait for the queue. */
export const IMPORT_QUEUE_ENV = "INGEST_IMPORT_QUEUE_ID";

/** Whether some session (any host) holds the import-queue lock. */
export async function importQueueActive(db: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ held: boolean }> }>;
}): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND granted
       AND classid=$1::int::oid AND objid=$2::int::oid AND objsubid=2) AS held`,
    [INGEST_LOCK_NAMESPACE, IMPORT_QUEUE_LOCK],
  );
  return !!rows[0]?.held;
}
