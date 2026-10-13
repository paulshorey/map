import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import { closeDb } from "@lib/db-map/db/postgres";
import { authorizeRequest, createDashboard } from "./server.js";

test("dashboard can be framed while retaining local request and content policies", async (t) => {
  const originalDbUrl = process.env.DB_MAP_URL;
  // Static requests never connect to PostgreSQL; keep this test usable without a live DB.
  process.env.DB_MAP_URL ??= "postgresql://unused@127.0.0.1:1/unused";
  const server = createDashboard(5001);
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closeDb();
    if (originalDbUrl === undefined) delete process.env.DB_MAP_URL;
    else process.env.DB_MAP_URL = originalDbUrl;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/`;
  const request = (headers: Record<string, string>) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      get(url, { headers }, (response) => {
        response.resume();
        response.on("end", () => resolve(response));
      }).on("error", reject);
    });
  const response = await request({ host: "127.0.0.1:5001" });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["content-type"] ?? "", /text\/html/);
  const policy = response.headers["content-security-policy"] ?? "";
  assert.ok(typeof policy === "string");
  assert.doesNotMatch(policy, /frame-ancestors/i);
  assert.equal(response.headers["x-frame-options"], undefined);
  for (const directive of [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
  ]) {
    assert.ok(policy.split("; ").includes(directive), directive);
  }
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  const foreign = await request({
    host: "127.0.0.1:5001",
    origin: "https://example.com",
  });
  assert.equal(foreign.statusCode, 403);
});
test("local API rejects DNS rebinding and foreign origins", () => {
  assert.equal(
    authorizeRequest(
      { method: "GET", headers: { host: "127.0.0.1:5001" } },
      5001,
    ),
    true,
  );
  assert.equal(
    authorizeRequest(
      { method: "GET", headers: { host: "evil.example:5001" } },
      5001,
    ),
    false,
  );
  assert.equal(
    authorizeRequest(
      {
        method: "GET",
        headers: { host: "127.0.0.1:5001", origin: "https://evil.example" },
      },
      5001,
    ),
    false,
  );
});
test("mutations require JSON and a non-simple same-origin request", () => {
  const headers = {
    host: "127.0.0.1:5001",
    origin: "http://127.0.0.1:5001",
    "content-type": "application/json",
    "x-ingestion-client": "dashboard",
  };
  assert.equal(authorizeRequest({ method: "POST", headers }, 5001), true);
  assert.equal(
    authorizeRequest(
      {
        method: "PATCH",
        headers: { ...headers, "x-ingestion-client": undefined },
      },
      5001,
    ),
    false,
  );
  assert.equal(
    authorizeRequest(
      { method: "POST", headers: { ...headers, "content-type": "text/plain" } },
      5001,
    ),
    false,
  );
  assert.equal(
    authorizeRequest(
      {
        method: "POST",
        headers: { ...headers, origin: "http://localhost:5000" },
      },
      5001,
    ),
    false,
  );
});
