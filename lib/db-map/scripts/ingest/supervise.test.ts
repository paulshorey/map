import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { rm, access } from "node:fs/promises";
import {
  parseSupervisorArgs,
  terminalOutcome,
  dispatchJob,
} from "./supervise.js";
import { createJob, jobPath, atomicJson } from "./supervisor-state.js";

test("expensive smoke cannot resume or expand cohort/deadline", () => {
  for (const args of [
    ["--resume", "id"],
    ["file", "--limit", "6"],
    ["file"],
    ["file", "--limit", "1", "--limit", "200"],
    ["file", "--limit", "1", "--consolidate"],
  ])
    assert.throws(() => parseSupervisorArgs(["smoke", "--", ...args]));
  assert.throws(() =>
    parseSupervisorArgs([
      "smoke",
      "--timeout-seconds",
      "61",
      "--",
      "file",
      "--limit",
      "1",
    ]),
  );
  assert.equal(
    parseSupervisorArgs(["smoke", "--", "file", "--limit", "1"]).timeout,
    45,
  );
});
test("long launch requires explicit callback choice and bounded deadline", () => {
  assert.throws(() =>
    parseSupervisorArgs(["start", "--", "--resume", randomUUID()]),
  );
  assert.throws(() =>
    parseSupervisorArgs([
      "start",
      "--local-only",
      "--notify-thread",
      randomUUID(),
      "--",
      "file",
    ]),
  );
  assert.throws(() =>
    parseSupervisorArgs([
      "start",
      "--local-only",
      "--max-hours",
      "169",
      "--",
      "file",
    ]),
  );
  assert.equal(
    parseSupervisorArgs([
      "start",
      "--notify-thread",
      randomUUID(),
      "--",
      "file",
    ]).maxHours,
    48,
  );
});
test("exit zero is insufficient proof of success", () => {
  assert.equal(
    terminalOutcome(0, undefined, "succeeded", new Date()),
    "succeeded",
  );
  assert.equal(terminalOutcome(0, undefined, "succeeded"), "needs_attention");
  assert.equal(terminalOutcome(0, undefined, "partial"), "needs_attention");
  assert.equal(
    terminalOutcome(2, undefined, "waiting_budget"),
    "waiting_budget",
  );
  assert.equal(
    terminalOutcome(null, "wall_clock_limit", "succeeded", new Date()),
    "needs_attention",
  );
});
test("healthy job cannot dispatch any model event", async () => {
  const id = randomUUID();
  await createJob({
    id,
    mode: "runner",
    argv: [],
    host: "fixture",
    runner_model: "gpt-5.6-luna",
    started_at: new Date().toISOString(),
    status: "running",
    timeout_seconds: 3600,
    health_interval_seconds: 3600,
    health_checks: 0,
  });
  try {
    await assert.rejects(dispatchJob(id), /No terminal result/);
  } finally {
    await rm(jobPath(id, ""), { recursive: true, force: true });
  }
});

test("accepted or ambiguous outbox receipts never call a model again", async () => {
  for (const status of ["sent", "sending", "uncertain"]) {
    const id = randomUUID();
    await createJob({
      id,
      mode: "runner",
      argv: [],
      host: "fixture",
      parent_thread: randomUUID(),
      runner_model: "gpt-5.6-luna",
      started_at: new Date().toISOString(),
      status: "finished",
      timeout_seconds: 3600,
      health_interval_seconds: 3600,
      health_checks: 0,
      result: { outcome: "needs_attention" },
    });
    try {
      await atomicJson(jobPath(id, "delivery.json"), { status });
      assert.equal((await dispatchJob(id)).status, status);
      await assert.rejects(access(jobPath(id, "summary.claim")));
    } finally {
      await rm(jobPath(id, ""), { recursive: true, force: true });
    }
  }
});
