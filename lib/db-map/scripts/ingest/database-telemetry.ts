import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { currentAttempt } from "./execution.js";
const pools = new WeakSet<Pool>(),
  clients = new WeakSet<PoolClient>();
const poolQuery = new AsyncLocalStorage<boolean>();
const operationContext = new AsyncLocalStorage<string>();
/** Code-owned labels only; never pass SQL, parameters or provider URLs. */
export const withDatabaseOperation = <T>(label: string, fn: () => T): T =>
  operationContext.run(label, fn);
type Lease = {
  acquired: number;
  role: string;
  stage?: string;
  source_record_id?: string;
  attempt_id?: string;
};
const leases = new WeakMap<Pool, Map<PoolClient, Lease>>();
type Counts = { total: number; idle: number; waiting: number };
type Acquisition = {
  request: number;
  started: number;
  before: Counts;
  label?: string;
  origin: Error;
};
type Diagnostics = {
  sequence: number;
  events: object[];
  ids: WeakMap<object, number>;
  nextClient: number;
};
const diagnostics = new WeakMap<Pool, Diagnostics>();
const counts = (db: Pool): Counts => ({
  total: db.totalCount,
  idle: db.idleCount,
  waiting: db.waitingCount,
});
function event(db: Pool, name: string, details: object = {}, client?: object) {
  const state = diagnostics.get(db);
  if (!state) return;
  if (client && !state.ids.has(client))
    state.ids.set(client, ++state.nextClient);
  state.events.push({
    at: new Date().toISOString(),
    event: name,
    ...details,
    ...(client ? { client: state.ids.get(client) } : {}),
    ...counts(db),
  });
  if (state.events.length > 64) state.events.shift();
}

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
  acquisition?: Acquisition,
) {
  if (!(error instanceof Error)) return error;
  try {
    const detail = error as Error & { code?: string; database?: unknown };
    if (!detail.database) {
      const held = [...(leases.get(db)?.values() ?? [])];
      detail.database = {
        operation,
        label: acquisition?.label ?? operationContext.getStore(),
        ...(acquisition
          ? {
              acquisition: {
                request: acquisition.request,
                elapsed_ms: Math.round(performance.now() - acquisition.started),
                before: acquisition.before,
                // These identify the driver's timeout path, never assert server saturation.
                timeout_kind:
                  detail.message === "timeout exceeded when trying to connect"
                    ? "pool_wait"
                    : detail.message ===
                        "Connection terminated due to connection timeout"
                      ? "connection_establishment"
                      : undefined,
                origin: acquisition.origin.stack,
              },
            }
          : {}),
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
        recent_events: [...(diagnostics.get(db)?.events ?? [])],
      };
    }
    if (
      operation === "checkout" &&
      !detail.code &&
      detail.message === "timeout exceeded when trying to connect"
    )
      detail.code = "database_pool_checkout_timeout";
    else if (
      operation === "checkout" &&
      !detail.code &&
      detail.message === "Connection terminated due to connection timeout"
    )
      detail.code = "database_connection_timeout";
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
    } else if (
      args[0] &&
      typeof args[0].callback === "function" &&
      typeof args[0].submit !== "function"
    ) {
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
  diagnostics.set(db, {
    sequence: 0,
    events: [],
    ids: new WeakMap(),
    nextClient: 0,
  });
  instrument(db, true, db);
  const connect = db.connect;
  if (typeof connect === "function")
    db.connect = function (this: Pool, ...args: any[]) {
      const acquisition: Acquisition = {
        request: ++diagnostics.get(db)!.sequence,
        started: performance.now(),
        before: counts(db),
        label: operationContext.getStore(),
        origin: new Error("Database acquisition requested here"),
      };
      event(db, "checkout_start", {
        request: acquisition.request,
        label: acquisition.label,
      });
      let settled = false;
      const finish = (error?: unknown) => {
        if (!settled) {
          settled = true;
          event(db, error ? "checkout_error" : "checkout_ready", {
            request: acquisition.request,
            elapsed_ms: Math.round(performance.now() - acquisition.started),
            code: (error as { code?: string })?.code,
          });
        }
        return attributeDatabaseError(db, error, "checkout", acquisition);
      };
      if (typeof args[0] === "function") {
        const callback = args[0];
        args[0] = (error: unknown, ...values: unknown[]) =>
          callback(finish(error), ...values);
      }
      try {
        const result = (connect as any).apply(this, args);
        return result && typeof result.then === "function"
          ? result.then(
              (client: PoolClient) => {
                finish();
                return client;
              },
              (error: unknown) => {
                throw finish(error);
              },
            )
          : result;
      } catch (error) {
        throw finish(error);
      }
    } as typeof db.connect;
  db.on("connect", (client: PoolClient) =>
    event(db, "connection_established", {}, client),
  );
  db.on("acquire", (client: PoolClient) => {
    event(db, "acquire", {}, client);
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
  db.on("release", (error: unknown, client: PoolClient) => {
    event(db, "release", { destroyed: !!error }, client);
    held.delete(client);
  });
  db.on("remove", (client: PoolClient) => {
    event(db, "remove", {}, client);
    held.delete(client);
  });
  db.on("error", (error: Error, client: PoolClient) =>
    event(
      db,
      "idle_error",
      { code: (error as { code?: string }).code },
      client,
    ),
  );
}
