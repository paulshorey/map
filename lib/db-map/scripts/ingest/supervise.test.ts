import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { rm, access } from "node:fs/promises";
import {
  parseSupervisorArgs,
  terminalOutcome,
  budgetedResume,
} from "./supervise.js";
import {
  createJob,
  jobPath,
  atomicJson,
  listJobs,
} from "./supervisor-state.js";

test("supervisor status checks exact local job PIDs", async () => {
  const id = randomUUID();
  await createJob({
    id,
    mode: "native",
    argv: [],
    host: hostname(),
    supervisor_pid: process.pid,
    child_pid: 2147483647,
    started_at: new Date().toISOString(),
    status: "running",
    timeout_seconds: null,
    health_interval_seconds: 3600,
    health_checks: 0,
  });
  try {
    const job = (await listJobs()).find((entry) => entry.id === id);
    assert.equal(job?.supervisor_present, true);
    assert.equal(job?.child_present, false);
  } finally {
    await rm(jobPath(id, ""), { recursive: true, force: true });
  }
});

test("terminal resume subtracts exact execution usage and never resets an exhausted budget", () => {
  const run = randomUUID();
  assert.equal(
    budgetedResume(
      run,
      { maxLlmRequests: 31816, maxCostUsd: 9.967241 },
      { requests: 46, estimated_cost_usd: 0.006764 },
    ),
    `pnpm --filter @lib/db-map ingest:run --resume ${run} --max-llm-requests 31770 --max-cost-usd 9.960477`,
  );
  assert.equal(
    budgetedResume(
      run,
      { maxLlmRequests: 1, maxCostUsd: 0.01 },
      { requests: 2, estimated_cost_usd: 0.02 },
    ),
    `pnpm --filter @lib/db-map ingest:run --resume ${run} --max-llm-requests 0 --max-cost-usd 0`,
  );
  assert.equal(
    budgetedResume(run, {}, { requests: 1, estimated_cost_usd: 0 }),
    `pnpm --filter @lib/db-map ingest:run --resume ${run}`,
  );
  assert.equal(
    budgetedResume(
      run,
      { unlimited: true, maxLlmRequests: 0, maxCostUsd: 0 },
      { requests: 100, estimated_cost_usd: 20 },
    ),
    `pnpm --filter @lib/db-map ingest:run --resume ${run} --unlimited`,
  );
});

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
test("start needs no callback choice; the completion deadline is optional", () => {
  const run = randomUUID();
  assert.equal(parseSupervisorArgs(["start", "--", "--resume", run]).maxHours, null);
  // The former flag is still accepted, so saved commands keep working.
  assert.deepEqual(
    parseSupervisorArgs(["start", "--local-only", "--max-hours", "48", "--", "file"]),
    parseSupervisorArgs(["start", "--max-hours", "48", "--", "file"]),
  );
  assert.throws(() => parseSupervisorArgs(["start", "--max-hours", "169", "--", "file"]));
  assert.throws(() => parseSupervisorArgs(["start"]));
  // The parent callback, its probe and the manual dispatch no longer exist.
  assert.throws(() =>
    parseSupervisorArgs(["start", "--notify-thread", randomUUID(), "--", "file"]),
  );
  assert.throws(() => parseSupervisorArgs(["probe", "--notify-thread", randomUUID()]));
  assert.throws(() => parseSupervisorArgs(["dispatch", "--job", randomUUID()]));
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
test("native watch allows uncapped continuous imports and validates optional limits", () => {
  const args = [
    "--resume",
    randomUUID(),
    "--max-llm-requests",
    "5",
    "--max-cost-usd",
    "0.1",
    "--geocode-limit",
    "0",
  ];
  assert.equal(
    parseSupervisorArgs(["watch", "--max-hours", "1", "--", ...args]).command,
    "watch",
  );
  assert.equal(
    parseSupervisorArgs([
      "watch",
      "--",
      "--resume",
      randomUUID(),
      "--unlimited",
    ]).maxHours,
    null,
  );
  assert.equal(parseSupervisorArgs(["watch", "--", "file"]).maxHours, null);
  assert.equal(
    parseSupervisorArgs(["watch", "--", "file", "--max-cost-usd", "1"]).command,
    "watch",
  );
  for (const bad of [
    ["watch", "--notify-thread", randomUUID(), "--", ...args],
    ["watch", "--", ...args, "--max-cost-usd", "10"],
    ["watch", "--", ...args, "--consolidate"],
    ["watch", "--", ...args.slice(0, -1), "-1"],
    ["watch", "--", ...args, "--unlimited"],
  ])
    assert.throws(() => parseSupervisorArgs(bad));
});
