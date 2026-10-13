import type { Pool, PoolClient } from "pg";
import { currentAttempt } from "./execution.js";
const pools = new WeakSet<Pool>(),
  clients = new WeakSet<PoolClient>();
/** Instrument round trips, not SQL text or parameters. One backend query is counted once. */
export function measureDatabase(db: Pool) {
  if (pools.has(db)) return;
  pools.add(db);
  db.on("acquire", (client: PoolClient) => {
    if (clients.has(client)) return;
    clients.add(client);
    const query = client.query;
    client.query = function (this: PoolClient, ...args: any[]) {
      const ctx = currentAttempt(),
        started = performance.now();
      const result = (query as any).apply(this, args);
      if (ctx && result && typeof result.finally === "function")
        return result.finally(() => {
          ctx.databaseMs = (ctx.databaseMs ?? 0) + performance.now() - started;
          ctx.databaseQueries = (ctx.databaseQueries ?? 0) + 1;
        });
      return result;
    } as typeof client.query;
  });
}
