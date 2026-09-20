import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeRequest } from "./server.js";
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
