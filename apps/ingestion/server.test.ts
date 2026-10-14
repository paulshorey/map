import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { get, type IncomingMessage } from "node:http";
import { closeDb } from "@lib/db-map/db/postgres";
import {
  authorizeRequest,
  createDashboard,
  dashboardContentSecurityPolicy,
} from "./server.js";

test("framing trusts loopback parents and only explicitly configured additional origins", () => {
  const policy = dashboardContentSecurityPolicy("");
  assert.match(
    policy,
    /frame-ancestors 'self' http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*;/,
  );
  assert.doesNotMatch(policy, /https:|\.ts\.net|frame-ancestors \*/);
  const privateOrigin = "https://pauls-macbook-pro.taila9173b.ts.net:8000";
  assert.ok(
    dashboardContentSecurityPolicy(privateOrigin).includes(privateOrigin),
  );
  for (const value of [
    "*",
    "https://*.ts.net",
    "https://example.com/path",
    "https://example.com?x=1",
    "https://example.com#x",
    "https://user:pass@example.com",
    "file:///tmp",
    "https://example.com;",
    "http://[::1]:8000",
    "http:example.com",
  ]) {
    assert.throws(() => dashboardContentSecurityPolicy(value), Error, value);
  }
});

test("static dashboard responses enforce framing and retain API/content protections", async (t) => {
  const originalDbUrl = process.env.DB_MAP_URL;
  const originalOrigins = process.env.INGESTION_FRAME_ORIGINS;
  // Static requests never connect to PostgreSQL.
  process.env.DB_MAP_URL ??= "postgresql://unused@127.0.0.1:1/unused";
  delete process.env.INGESTION_FRAME_ORIGINS;
  const server = createDashboard(5001);
  t.after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await closeDb();
    if (originalDbUrl === undefined) delete process.env.DB_MAP_URL;
    else process.env.DB_MAP_URL = originalDbUrl;
    if (originalOrigins === undefined)
      delete process.env.INGESTION_FRAME_ORIGINS;
    else process.env.INGESTION_FRAME_ORIGINS = originalOrigins;
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const request = (headers: Record<string, string>) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      get(`http://127.0.0.1:${address.port}/`, { headers }, (response) => {
        response.resume();
        response.on("end", () => resolve(response));
      }).on("error", reject);
    });
  const response = await request({ host: "127.0.0.1:5001" });
  assert.equal(response.statusCode, 200);
  assert.equal(
    response.headers["content-security-policy"],
    dashboardContentSecurityPolicy(""),
  );
  assert.equal(response.headers["x-frame-options"], undefined);
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal((await request({ host: "evil.example:5001" })).statusCode, 403);
  assert.equal(
    (await request({ host: "127.0.0.1:5001", origin: "https://evil.example" }))
      .statusCode,
    403,
  );
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
