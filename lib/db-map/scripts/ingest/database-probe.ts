import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client, type PoolClient } from "pg";
import { getDb, closeDb } from "../../lib/db/postgres.js";
import { measureDatabase } from "./database-telemetry.js";

// Fixed read-only matrix: 12 acquisitions, <=3 simultaneous clients, no providers.
// A Node timer owns the two actual idle-expiry waits, within a 120-second deadline.
process.env.PG_POOL_MAX ||= "16";
const db = getDb();
db.options.application_name = "map-database-diagnosis";
db.options.query_timeout = 5_000;
measureDatabase(db);
const start = performance.now();
const events: unknown[] = [],
  trials: unknown[] = [];
const leased = new Set<PoolClient>(),
  direct = new Set<Client>();
const clientIds = new WeakMap<object, number>();
let sequence = 0,
  expired = false;
const id = (client: object) => {
  if (!clientIds.has(client)) clientIds.set(client, ++sequence);
  return clientIds.get(client);
};
const counts = () => ({
  total: db.totalCount,
  idle: db.idleCount,
  waiting: db.waitingCount,
});
const safeError = (error: unknown) => ({
  name: error instanceof Error ? error.name : "Error",
  // Do not serialize arbitrary driver messages, SQL, parameters or endpoints.
  code: (error as { code?: string })?.code ?? null,
  database: (error as { database?: unknown })?.database,
});
for (const event of [
  "connect",
  "acquire",
  "release",
  "remove",
  "error",
] as const) {
  db.on(event, (...args: any[]) => {
    const client = args[event === "release" || event === "error" ? 1 : 0];
    if (events.length < 160)
      events.push({
        event,
        ms: Math.round(performance.now() - start),
        client: client ? id(client) : null,
        ...(event === "error" ? { error: safeError(args[0]) } : {}),
        ...counts(),
      });
  });
}
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
const controller = new AbortController();
const deadline = setTimeout(() => {
  expired = true;
  controller.abort();
  for (const client of direct) void client.end().catch(() => undefined);
  for (const client of leased) {
    client.release(true);
    leased.delete(client);
  }
  void closeDb();
}, 120_000);
const query = async (client: Client | PoolClient) => {
  const at = performance.now();
  await client.query("SELECT 1");
  return Math.round(performance.now() - at);
};
async function fresh(label: string, inspect = false) {
  if (expired) throw new Error("Diagnostic deadline exceeded");
  const client = new Client({
    ...db.options,
    application_name: "map-database-diagnosis-direct",
  });
  direct.add(client);
  const at = performance.now();
  try {
    await client.connect();
    const acquired = performance.now();
    const queryMs = await query(client);
    let server: unknown;
    if (inspect) {
      const { rows } =
        await client.query(`SELECT current_setting('server_version') AS version,
        current_setting('max_connections')::int AS max_connections,
        count(*)::int AS sessions,
        count(*) FILTER (WHERE state IS NULL)::int AS hidden_state_sessions,
        jsonb_object_agg(pid, jsonb_build_object('state',state,'wait_type',wait_event_type,
          'wait',wait_event,'transaction_age_seconds',extract(epoch FROM clock_timestamp()-xact_start)))
          FILTER (WHERE application_name LIKE 'map-database-diagnosis%') AS owned_sessions
        FROM pg_stat_activity`);
      server = rows[0];
    }
    trials.push({
      label,
      path: "direct",
      acquisition_ms: Math.round(acquired - at),
      query_ms: queryMs,
      server,
    });
  } catch (error) {
    trials.push({ label, path: "direct", error: safeError(error) });
    throw error;
  } finally {
    direct.delete(client);
    await client.end().catch(() => undefined);
  }
}
async function pooled(label: string, callback = false) {
  if (expired) throw new Error("Diagnostic deadline exceeded");
  const at = performance.now(),
    before = counts();
  let client: PoolClient | undefined;
  try {
    client = callback
      ? await new Promise<PoolClient>((resolve, reject) =>
          db.connect((error, c) => (error ? reject(error) : resolve(c!))),
        )
      : await db.connect();
    leased.add(client);
    const acquired = performance.now(),
      queryMs = await query(client);
    trials.push({
      label,
      path: "pool",
      callback,
      client: id(client),
      acquisition_ms: Math.round(acquired - at),
      query_ms: queryMs,
      before,
    });
  } catch (error) {
    trials.push({ label, path: "pool", before, error: safeError(error) });
    throw error;
  } finally {
    if (client && leased.delete(client)) client.release();
  }
}
let failure: unknown;
try {
  // Do not silently turn an environment override into a multi-minute diagnostic.
  if (
    db.options.connectionTimeoutMillis !== 10_000 ||
    db.options.idleTimeoutMillis !== 30_000
  )
    throw new Error(
      "Probe requires the reviewed 10s connection and 30s idle defaults",
    );
  await fresh("fresh-1", true);
  await fresh("fresh-2");
  await fresh("fresh-3");
  await pooled("cold");
  await pooled("warm");
  await pooled("warm-callback", true);
  await Promise.all([
    pooled("parallel-1"),
    pooled("parallel-2"),
    pooled("parallel-3"),
  ]);
  await delay(31_000, undefined, { signal: controller.signal });
  await pooled("after-idle-expiry-1");
  await pooled("warm-after-expiry");
  await delay(31_000, undefined, { signal: controller.signal });
  await pooled("after-idle-expiry-2", true);
} catch (error) {
  failure = safeError(error);
  process.exitCode = 1;
} finally {
  await closeDb();
  clearTimeout(deadline);
  lag.disable();
  const require = createRequire(import.meta.url),
    poolRequire = createRequire(require.resolve("pg"));
  console.log(
    JSON.stringify(
      {
        observed_at: new Date().toISOString(),
        elapsed_ms: Math.round(performance.now() - start),
        runtime: {
          node: process.version,
          executable: process.execPath,
          pg: require("pg/package.json").version,
          pg_pool: JSON.parse(
            readFileSync(
              join(dirname(poolRequire.resolve("pg-pool")), "package.json"),
              "utf8",
            ),
          ).version,
        },
        config: {
          max: db.options.max,
          idle_ms: db.options.idleTimeoutMillis,
          connection_ms: db.options.connectionTimeoutMillis,
        },
        deadline_exceeded: expired,
        failure,
        trials,
        events,
        event_loop_ms: {
          max: lag.max / 1e6,
          mean: lag.mean / 1e6,
          p99: lag.percentile(99) / 1e6,
        },
        final: {
          ...counts(),
          explicit_leases: leased.size,
          direct_clients: direct.size,
        },
      },
      null,
      2,
    ),
  );
}
