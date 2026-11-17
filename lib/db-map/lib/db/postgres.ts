import { Client, Pool } from "pg";

let pool: Pool | undefined;

export const getDb = () => {
  if (!pool) {
    const connectionString = process.env.DB_MAP_URL;
    if (!connectionString) {
      throw new Error("DB_MAP_URL environment variable not set");
    }

    pool = new Pool({
      connectionString,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
      connectionTimeoutMillis: Number(
        process.env.PG_CONNECTION_TIMEOUT_MS || 10_000,
      ),
      keepAlive: true,
      keepAliveInitialDelayMillis: Number(
        process.env.PG_KEEPALIVE_INITIAL_DELAY_MS || 10_000,
      ),
    });

    pool.on("error", (err) => {
      console.error("Postgres pool idle client error:", err);
    });
  }

  return pool;
};

/**
 * A connection outside the shared pool, for session-level advisory locks held for a whole run,
 * so a small pool can never be exhausted by its own lock holders. Close it with `end()`.
 */
export async function dedicatedClient(
  applicationName?: string,
  /** Called once if the connection fails or closes before `end()`: its session locks are gone. */
  onLost?: (error: unknown) => void,
): Promise<Client> {
  const connectionString = process.env.DB_MAP_URL;
  if (!connectionString) throw new Error("DB_MAP_URL environment variable not set");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10_000),
    keepAlive: true,
    application_name: applicationName,
  });
  let ending = false,
    lost = false;
  const lose = (error: unknown) => {
    if (ending || lost) return;
    lost = true;
    console.error("Postgres lock connection lost; its advisory locks are released:", error);
    onLost?.(error);
  };
  client.on("error", lose);
  client.on("end", () => lose(new Error("connection ended")));
  await client.connect();
  const end = client.end.bind(client);
  client.end = (() => {
    ending = true;
    return end();
  }) as typeof client.end;
  return client;
}

const sidePools = new Map<string, Pool>();
/**
 * A small named pool separate from the operational pool, for slow background work (such as
 * dashboard aggregates) that must never hold up live queries.
 */
export function getSidePool(name: string, max = 1): Pool {
  let side = sidePools.get(name);
  if (!side) {
    const connectionString = process.env.DB_MAP_URL;
    if (!connectionString) throw new Error("DB_MAP_URL environment variable not set");
    side = new Pool({
      connectionString,
      max,
      idleTimeoutMillis: 30_000,
      // pg's default is no connection timeout: a stalled connect would block every caller.
      connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 10_000),
      keepAlive: true,
    });
    side.on("error", (err) => console.error(`Postgres ${name} pool idle client error:`, err));
    sidePools.set(name, side);
  }
  return side;
}

export async function closeDb() {
  if (!pool) return;
  const current = pool;
  pool = undefined;
  await current.end().catch(() => undefined);
}
