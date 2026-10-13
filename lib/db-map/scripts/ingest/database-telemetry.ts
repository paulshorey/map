import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool, PoolClient } from "pg";
import { currentAttempt } from "./execution.js";
const pools = new WeakSet<Pool>(),
  clients = new WeakSet<PoolClient>();
const poolQuery = new AsyncLocalStorage<boolean>();
/** Count pool waiting plus round trips once; never retain SQL text or parameters. */
function instrument(target: Pool | PoolClient, isPool: boolean) {
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
        return callback(...values);
      };
    } else if (args[0] && typeof args[0].callback === "function") {
      const callback = args[0].callback;
      args[0] = {
        ...args[0],
        callback: (...values: any[]) => {
          finish();
          return callback(...values);
        },
      };
    }
    try {
      const invoke = () => (query as any).apply(this, args);
      const result = isPool ? poolQuery.run(true, invoke) : invoke();
      return result && typeof result.finally === "function"
        ? result.finally(finish)
        : result;
    } catch (error) {
      finish();
      throw error;
    }
  } as typeof target.query;
}
export function measureDatabase(db: Pool) {
  if (pools.has(db)) return;
  pools.add(db);
  instrument(db, true);
  db.on("acquire", (client: PoolClient) => {
    if (clients.has(client)) return;
    clients.add(client);
    instrument(client, false);
  });
}
