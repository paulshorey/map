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
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
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
      if (req.method === "GET" && url.pathname === "/api/inventory") {
        json(200, {
          ...(await inventory()),
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
