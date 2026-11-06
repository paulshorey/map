import { getOverview } from "@lib/db-map/sql/ingestion-overview";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { getDb } from "@lib/db-map/db/postgres";
import {
  getInventory,
  getInventoryDetail,
  editInventory,
  pauseIngestion,
  UUID,
} from "@lib/db-map/sql/ingestion-inventory";
import { refreshInventory } from "@lib/db-map/ingestion/inventory-scan";
import { inspectRun, parseStatusArgs } from "@lib/db-map/ingest/status";
import { controlState } from "@lib/db-map/sql/ingestion-control";
import {
  EMPTY_QUALITY,
  getIngestionMonitor,
  getQualityMonitor,
} from "@lib/db-map/sql/ingestion-monitor";
import { activeOrLocalQueue, reconcileStale } from "@lib/db-map/ingest/import-queue";

/**
 * A bounded view of a queue for the dashboard: up to 30 entries around the current one, plus
 * counts by status for the whole plan (plans can be long).
 */
export function queueWindow<
  Q extends { entries: Array<{ status: string }>; current?: number | null },
>(queue: Q | null) {
  if (!queue) return null;
  const total = queue.entries.length;
  const center = queue.current ?? queue.entries.findIndex((e) => e.status !== "succeeded" && e.status !== "skipped_complete");
  const start = Math.max(0, Math.min(Math.max(0, center) - 5, total - 30));
  const counts: Record<string, number> = {};
  for (const e of queue.entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return {
    ...queue,
    entries: queue.entries.slice(start, start + 30),
    entries_offset: start,
    entries_total: total,
    entry_counts: counts,
  };
}

const QUALITY_TTL_MS = 120_000;
const QUALITY_RETRY_MS = 30_000;
type Quality = Awaited<ReturnType<typeof getQualityMonitor>>;
let qualityCache: { at: number; value: Quality | null } = { at: 0, value: null };
let qualityRefresh: Promise<void> | null = null;

/**
 * Whole-table quality aggregates, refreshed at most every two minutes by one shared request.
 * A failed refresh keeps serving the previous value and retries after 30 seconds.
 */
async function cachedQuality(db: Parameters<typeof getQualityMonitor>[0]): Promise<Quality | null> {
  if (Date.now() - qualityCache.at > QUALITY_TTL_MS) {
    qualityRefresh ??= getQualityMonitor(db)
      .then((value) => {
        qualityCache = { at: Date.now(), value };
      })
      .catch((error) => {
        console.error("Quality monitor refresh failed:", error);
        qualityCache = { at: Date.now() - QUALITY_TTL_MS + QUALITY_RETRY_MS, value: qualityCache.value };
      })
      .finally(() => {
        qualityRefresh = null;
      });
    // The first load waits; later refreshes serve the previous value meanwhile.
    if (!qualityCache.value) await qualityRefresh;
  }
  return qualityCache.value;
}

export function dashboardContentSecurityPolicy(
  extraOrigins = process.env.INGESTION_FRAME_ORIGINS ?? "",
) {
  // local-dev's port is configurable. Trust only loopback hosts by default,
  // never a parent inferred from Referer, Origin or forwarding headers.
  const parents = new Set([
    "'self'",
    "http://127.0.0.1:*",
    "http://localhost:*",
  ]);
  for (const value of extraOrigins.split(/\s+/).filter(Boolean)) {
    const origin = new URL(value);
    if (
      !["http:", "https:"].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      /[\s*;'"\[\]]/.test(value) ||
      (value !== origin.origin && value !== `${origin.origin}/`)
    )
      throw new Error(
        "INGESTION_FRAME_ORIGINS must contain exact HTTP(S) origins",
      );
    parents.add(origin.origin);
  }
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors ${[...parents].join(" ")}; base-uri 'none'; form-action 'self'`;
}

export function authorizeRequest(
  req: Pick<IncomingMessage, "headers" | "method">,
  port: number,
) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host ?? "")) return false;
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
    return false;
  if (!["GET", "HEAD"].includes(req.method ?? ""))
    return (
      req.headers["x-ingestion-client"] === "dashboard" &&
      req.headers["content-type"]?.split(";")[0] === "application/json"
    );
  return true;
}
async function body(req: IncomingMessage) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 20000) throw new Error("Request too large");
  }
  return JSON.parse(data || "{}");
}
export function createDashboard(port: number) {
  const contentSecurityPolicy = dashboardContentSecurityPolicy();
  const db = getDb();
  let refreshing = false;
  let refreshResult: unknown = null;
  let refreshError: string | null = null;
  let snapshot: ReturnType<typeof getInventory> | undefined;
  let cachedAt = 0;
  const invalidate = () => {
    cachedAt = 0;
    snapshot = undefined;
  };
  const inventory = () => {
    if (!snapshot || Date.now() - cachedAt > 4000) {
      cachedAt = Date.now();
      snapshot = getInventory(db).catch((error) => {
        invalidate();
        throw error;
      });
    }
    return snapshot;
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify(value));
    };
    if (!authorizeRequest(req, port)) {
      json(403, { error: "Local same-origin requests only" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/overview") {
        const run = url.searchParams.get("run") ?? undefined;
        if (run && !UUID.test(run)) {
          json(400, { error: "Run must be a UUID" });
          return;
        }
        const limit = Number(url.searchParams.get("limit") ?? 20),
          offset = Number(url.searchParams.get("offset") ?? 0);
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !Number.isSafeInteger(offset) ||
          offset < 0
        ) {
          json(400, { error: "Invalid file pagination" });
          return;
        }
        const result = await getOverview(db, {
          run,
          file: url.searchParams.get("file") ?? undefined,
          limit,
          offset,
          detail: url.searchParams.get("detail") === "1",
          includeInventory: url.searchParams.get("inventory") === "1",
        });
        if (result.inventory)
          result.inventory = {
            ...result.inventory,
            control: result.control?.maintenance,
            refreshing,
            refreshResult,
            refreshError,
          };
        json(
          result.components.database.status === "unknown" ? 503 : 200,
          result,
        );
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/monitor") {
        // Whole-table quality aggregates are cached; run progress and quota stay live.
        const quality = await cachedQuality(db);
        const [monitor, queue] = await Promise.all([
          getIngestionMonitor(db, quality ?? EMPTY_QUALITY),
          // Reconcile first so a queue whose worker died is not shown as running; a live queue
          // on another host (presence holder without local state) is shown as remote.
          reconcileStale()
            .catch(() => undefined)
            .then(() => activeOrLocalQueue())
            .catch(() => null),
        ]);
        // No cached value yet and the first load failed: unavailable, never fabricated zeros.
        json(200, { ...monitor, quality: quality ?? null, queue: queueWindow(queue) });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/inventory") {
        json(200, {
          ...(await inventory()),
          control: await controlState(db),
          refreshing,
          refreshResult,
          refreshError,
        });
        return;
      }
      const fileMatch = url.pathname.match(/^\/api\/files\/([\da-f-]+)$/i);
      if (fileMatch && UUID.test(fileMatch[1]!)) {
        if (req.method === "GET") {
          json(200, await getInventoryDetail(db, fileMatch[1]!));
          return;
        }
        if (req.method === "PATCH") {
          json(200, await editInventory(db, fileMatch[1]!, await body(req)));
          invalidate();
          return;
        }
      }
      const runMatch = url.pathname.match(
        /^\/api\/runs\/([\da-f-]+)(\/pause)?$/i,
      );
      if (runMatch && UUID.test(runMatch[1]!)) {
        if (req.method === "GET" && !runMatch[2]) {
          json(
            200,
            await inspectRun(
              db,
              parseStatusArgs(["--run", runMatch[1]!, "--limit", "10"]),
            ),
          );
          return;
        }
        if (req.method === "POST" && runMatch[2]) {
          await body(req);
          json(200, await pauseIngestion(db, runMatch[1]!));
          invalidate();
          return;
        }
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        await body(req);
        if (refreshing) {
          json(409, { error: "Inventory refresh already running" });
          return;
        }
        refreshing = true;
        refreshError = null;
        void refreshInventory(db)
          .then((result) => {
            refreshResult = result;
          })
          .catch((error) => {
            refreshError =
              error instanceof Error ? error.message : String(error);
          })
          .finally(() => {
            refreshing = false;
            invalidate();
          });
        json(202, { started: true });
        return;
      }
      const assets: Record<string, [string, string]> = {
        "/": ["index.html", "text/html"],
        "/app.js": ["app.js", "text/javascript"],
        "/style.css": ["style.css", "text/css"],
      };
      const asset = assets[url.pathname];
      if (req.method === "GET" && asset) {
        res.writeHead(200, { "Content-Type": `${asset[1]}; charset=utf-8` });
        res.end(
          await readFile(new URL(`./public/${asset[0]}`, import.meta.url)),
        );
        return;
      }
      json(404, { error: "Not found" });
    } catch (error) {
      json(400, {
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  });
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(
    process.env.INGESTION_DASHBOARD_PORT ?? process.env.PORT ?? 5001,
  );
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid INGESTION_DASHBOARD_PORT");
  const server = createDashboard(port);
  server.listen(port, "127.0.0.1", () =>
    console.log(
      `Ingestion dashboard: http://127.0.0.1:${port}\nFull ingestion stays in your terminal. Inventory scans never call providers.`,
    ),
  );
}
