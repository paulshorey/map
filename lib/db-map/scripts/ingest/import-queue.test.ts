import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  assertPrimaryCheckout,
  classifyResult,
  isConnectivityError,
  parseEntries,
} from "./import-queue.js";

const base = { coverage: "partial", runId: "run", quickQuotaPauses: 0 };

test("a file advances only on success with verified complete coverage", () => {
  assert.deepEqual(classifyResult({ ...base, outcome: "succeeded", coverage: "complete" }), { action: "advance" });
  const unverified = classifyResult({ ...base, outcome: "succeeded", coverage: "ready_to_verify" });
  assert.equal(unverified.action, "attention");
});

test("the daily quota waits and resumes; repeated immediate exhaustion needs attention", () => {
  const quota = { ...base, outcome: "waiting_budget", stopReason: "provider_daily_quota" };
  assert.deepEqual(classifyResult(quota), { action: "wait_quota" });
  assert.deepEqual(classifyResult({ ...quota, quickQuotaPauses: 1 }), { action: "wait_quota" });
  assert.equal(classifyResult({ ...quota, quickQuotaPauses: 2 }).action, "attention");
  assert.equal(classifyResult({ ...quota, runId: null }).action, "attention");
});

test("every other outcome stops the queue without a retry", () => {
  for (const outcome of ["needs_attention", "partial", "paused", "waiting_budget", "exit_1"]) {
    const step = classifyResult({ ...base, outcome, stopReason: "provider_budget" });
    assert.equal(step.action, "attention", outcome);
  }
});

test("entries parse as <file>=<category>", () => {
  assert.deepEqual(parseEntries(["data/poi/a=b.json=art_fair"]), [{ file: "data/poi/a=b.json", category: "art_fair" }]);
  assert.throws(() => parseEntries(["data/poi/a.json"]));
});

test("whole-file imports are refused from a linked worktree", () => {
  const git = (arg: string) =>
    execFileSync("git", ["rev-parse", "--path-format=absolute", arg], { encoding: "utf8" }).trim();
  // In a linked worktree the git directory differs from the repository's common directory.
  if (git("--git-dir") === git("--git-common-dir")) assertPrimaryCheckout("start");
  else assert.throws(() => assertPrimaryCheckout("start"), /must run from the primary checkout/);
});

test("a lost database connection is recognised; provider and other failures are not", () => {
  const host = "db.example.net";
  const pgStack =
    "Error: timeout exceeded when trying to connect\n    at /repo/node_modules/.pnpm/pg-pool@3.14.0_pg@8.21.0/node_modules/pg-pool/index.js:45:11";
  // As stored on the executions that failed on 2026-11-16.
  for (const error of [
    { code: "database_pool_checkout_timeout", message: "timeout exceeded when trying to connect" },
    { code: "ENOTFOUND", message: `getaddrinfo ENOTFOUND ${host}` },
    { code: "ENOTFOUND", stack: `Error: getaddrinfo ENOTFOUND other.host\n${pgStack}` },
    { message: `connect ENETUNREACH ${host}:5432` },
    { message: "Connection terminated unexpectedly" },
  ])
    assert.equal(isConnectivityError(error, host), true, JSON.stringify(error));
  for (const error of [
    null,
    undefined,
    // A provider's network error needs diagnosis first.
    { code: "ETIMEDOUT", message: "request to https://geocoder.example.com timed out" },
    { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.provider.example" },
    "read ECONNRESET",
    { code: "systemic_unlocated", message: "25 records in a row could not be located" },
    { code: "outdated_data", message: "records were produced by older pipeline logic" },
    { message: "Lineage verification: 2 violation(s)" },
    {
      code: "23505",
      message: "duplicate key value violates unique constraint",
      stack: "error: duplicate key\n    at /repo/node_modules/.pnpm/pg@8.21.0/node_modules/pg/lib/client.js:1:1",
    },
    { status: 401, message: "Unauthorized" },
  ])
    assert.equal(isConnectivityError(error, host), false, JSON.stringify(error));
});
