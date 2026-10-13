import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { currentAttempt } from "./execution.js";
const pools = new WeakSet<Pool>(),
  clients = new WeakSet<PoolClient>();
const poolQuery = new AsyncLocalStorage<boolean>();
type Lease = {
  acquired: number;
  role: string;
  stage?: string;
  source_record_id?: string;
  attempt_id?: string;
};
const leases = new WeakMap<Pool, Map<PoolClient, Lease>>();

export function labelDatabaseConnection(
  db: Pool,
  client: PoolClient,
  role: string,
) {
  const lease = leases.get(db)?.get(client);
  if (lease) lease.role = role;
}

/** Diagnostic metadata only: no SQL, parameters, credentials, or automatic query replay. */
function attributeDatabaseError(
  db: Pool,
  error: unknown,
  operation: "checkout" | "query",
) {
  if (!(error instanceof Error)) return error;
  try {
    const detail = error as Error & { code?: string; database?: unknown };
    if (!detail.database) {
      const held = [...(leases.get(db)?.values() ?? [])];
      detail.database = {
        operation,
        pool: {
          max: db.options?.max,
          total: db.totalCount,
          idle: db.idleCount,
          waiting: db.waitingCount,
          connection_timeout_ms: db.options?.connectionTimeoutMillis,
          holders: held
            .sort((a, b) => a.acquired - b.acquired)
            .slice(0, 20)
            .map(({ acquired, ...owner }) => ({
              ...owner,
              held_ms: Math.round(performance.now() - acquired),
            })),
          holders_truncated: held.length > 20,
        },
      };
    }
    if (
      operation === "checkout" &&
      !detail.code &&
      detail.message === "timeout exceeded when trying to connect"
    )
      detail.code = "database_pool_checkout_timeout";
  } catch {
    // Frozen/nonstandard errors must retain their original failure semantics.
  }
  return error;
}
/** Count pool waiting plus round trips once; never retain SQL text or parameters. */
function instrument(target: Pool | PoolClient, isPool: boolean, db: Pool) {
  const query = target.query;
  target.query = function (this: Pool | PoolClient, ...args: any[]) {
    const ctx = !poolQuery.getStore() ? currentAttempt() : undefined;
    const started = performance.now();
    let measured = false;
    const finish = () => {
      if (!ctx || measured) return;
      measured = true;
      ctx.databaseMs = (ctx.databaseMs ?? 0) + performance.now() - started;
      ctx.databaseQueries = (ctx.databaseQueries ?? 0) + 1;
    };
    const last = args.length - 1;
    if (typeof args[last] === "function") {
      const callback = args[last];
      args[last] = (...values: any[]) => {
        finish();
        if (values[0]) attributeDatabaseError(db, values[0], "query");
        return callback(...values);
      };
    } else if (args[0] && typeof args[0].callback === "function") {
      const callback = args[0].callback;
      args[0] = {
        ...args[0],
        callback: (...values: any[]) => {
          finish();
          if (values[0]) attributeDatabaseError(db, values[0], "query");
          return callback(...values);
        },
      };
    }
    try {
      const invoke = () => (query as any).apply(this, args);
      const result = isPool ? poolQuery.run(true, invoke) : invoke();
      return result && typeof result.finally === "function"
        ? result.then(
            (value: unknown) => {
              finish();
              return value;
            },
            (error: unknown) => {
              finish();
              throw attributeDatabaseError(db, error, "query");
            },
          )
        : result;
    } catch (error) {
      finish();
      throw attributeDatabaseError(db, error, "query");
    }
  } as typeof target.query;
}
export function measureDatabase(db: Pool) {
  if (pools.has(db)) return;
  pools.add(db);
  const held = new Map<PoolClient, Lease>();
  leases.set(db, held);
  instrument(db, true, db);
  const connect = db.connect;
  if (typeof connect === "function")
    db.connect = function (this: Pool, ...args: any[]) {
      if (typeof args[0] === "function") {
        const callback = args[0];
        args[0] = (error: unknown, ...values: unknown[]) =>
          callback(attributeDatabaseError(db, error, "checkout"), ...values);
      }
      try {
        const result = (connect as any).apply(this, args);
        return result && typeof result.catch === "function"
          ? result.catch((error: unknown) => {
              throw attributeDatabaseError(db, error, "checkout");
            })
          : result;
      } catch (error) {
        throw attributeDatabaseError(db, error, "checkout");
      }
    } as typeof db.connect;
  db.on("acquire", (client: PoolClient) => {
    const ctx = currentAttempt();
    held.set(client, {
      acquired: performance.now(),
      role: poolQuery.getStore() ? "pool_query" : "explicit",
      stage: ctx?.stage,
      source_record_id: ctx?.claim?.source_record_id,
      attempt_id: ctx?.attemptId,
    });
    if (clients.has(client)) return;
    clients.add(client);
    instrument(client, false, db);
  });
  db.on("release", (_error: unknown, client: PoolClient) =>
    held.delete(client),
  );
  db.on("remove", (client: PoolClient) => held.delete(client));
}
