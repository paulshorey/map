/** Database-wide lock allocation. Two-int keys never overlap bigint keys. */
export const INGEST_LOCK_NAMESPACE = 91832;
export const INVENTORY_SCAN_LOCK = 3;
export const CANONICAL_WRITER_LOCK = 0x5018a;
/** Held for its lifetime by the one import-queue worker (ingest:import-queue), on any host. */
export const IMPORT_QUEUE_LOCK = 4;
