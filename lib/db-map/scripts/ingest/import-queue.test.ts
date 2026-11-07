import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyResult, parseEntries } from "./import-queue.js";

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
