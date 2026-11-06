/**
 * Database-backed admission for imports, held on a dedicated connection for the whole run:
 *
 * - every full-scope import (no --limit/--record/--shadow) holds FULL_IMPORT_LOCK exclusively,
 *   so only one full-file import runs at a time on any host, whoever launched it;
 * - a full-scope import not launched by the import queue also holds the queue lock in shared
 *   mode, so it is refused while a queue worker owns ingestion (the worker holds it
 *   exclusively). Bounded diagnostics are never blocked.
 *
 * The locks belong to the import process itself, so they hold even if a queue worker dies.
 */
import type { Client, Pool } from "pg";
import { dedicatedClient } from "../../lib/db/postgres.js";
import {
  FULL_IMPORT_LOCK,
  IMPORT_QUEUE_ENV,
  IMPORT_QUEUE_LOCK,
  INGEST_LOCK_NAMESPACE,
} from "../../lib/ingestion/locks.js";

export interface AdmissionScope {
  dryRun?: boolean;
  limit?: number;
  record?: string;
  shadow?: boolean;
}

export const isFullScope = (o: AdmissionScope) =>
  o.limit === undefined && !o.record && !o.shadow;

export async function admitImport(db: Pool, scope: AdmissionScope): Promise<() => Promise<void>> {
  if (scope.dryRun) return async () => {};
  const fromQueue = !!process.env[IMPORT_QUEUE_ENV];
  const full = isFullScope(scope);
  if (fromQueue && !full) return async () => {};
  // Held for the whole run on its own connection, outside the operational pool.
  void db;
  const fence: Client = await dedicatedClient("ingest-admission");
  const held: string[] = [];
  const release = async () => {
    for (const sql of held.reverse())
      await fence.query(sql, [INGEST_LOCK_NAMESPACE]).catch(() => undefined);
    await fence.end().catch(() => undefined);
  };
  try {
    // Bounded diagnostics (--limit/--record/--shadow) run beside a queue; full imports do not.
    if (!fromQueue && full) {
      const { rows } = await fence.query("SELECT pg_try_advisory_lock_shared($1, $2) AS ok", [
        INGEST_LOCK_NAMESPACE,
        IMPORT_QUEUE_LOCK,
      ]);
      if (!rows[0]?.ok)
        throw new Error(
          "An import queue is running (ingest:import-queue status); stop it or add this file to a queue",
        );
      held.push(`SELECT pg_advisory_unlock_shared($1, ${IMPORT_QUEUE_LOCK})`);
    }
    if (full) {
      const { rows } = await fence.query("SELECT pg_try_advisory_lock($1, $2) AS ok", [
        INGEST_LOCK_NAMESPACE,
        FULL_IMPORT_LOCK,
      ]);
      if (!rows[0]?.ok)
        throw new Error(
          "Another full-file import is running (one at a time); wait for it, or use --limit for a bounded diagnostic",
        );
      held.push(`SELECT pg_advisory_unlock($1, ${FULL_IMPORT_LOCK})`);
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
