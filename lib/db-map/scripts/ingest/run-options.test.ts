import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "./run.js";
import { resolveResumeOptions } from "./orchestrator.js";

const runId = "4dda8606-9c20-4275-bae6-c14cdea9e38c";

test("unlimited resume clears historic exhausted caps without changing the pinned cohort", () => {
  const saved = parseArgs([
    "original.json",
    "--category",
    "campground",
    "--record",
    "a",
    "--max-llm-requests",
    "0",
    "--max-cost-usd",
    "0",
    "--geocode-limit",
    "0",
    "--stop-after",
    "normalize",
  ]);
  const opts = resolveResumeOptions(
    saved,
    parseArgs(["--resume", runId, "--unlimited"]),
    runId,
    "moved.json",
  );
  assert.equal(opts.unlimited, true);
  assert.equal(opts.maxLlmRequests, undefined);
  assert.equal(opts.maxCostUsd, undefined);
  assert.equal(opts.geocodeLimit, undefined);
  assert.equal(opts.limit, 1);
  assert.equal(opts.record, "a");
  assert.equal(opts.category, "campground");
  assert.equal(opts.file, "moved.json");
  assert.equal(opts.stopAfter, undefined);
  assert.equal(saved.maxCostUsd, 0);
});

test("optional explicit caps remain available without making them required", () => {
  const saved = parseArgs([
    "file.json",
    "--category",
    "campground",
    "--unlimited",
  ]);
  const opts = resolveResumeOptions(
    saved,
    parseArgs(["--resume", runId, "--max-llm-requests", "2"]),
    runId,
    "file.json",
  );
  assert.equal(opts.unlimited, false);
  assert.equal(opts.maxLlmRequests, 2);
  assert.equal(opts.maxCostUsd, undefined);
  assert.equal(
    parseArgs(["file.json", "--category", "campground"]).geocodeLimit,
    undefined,
  );
});

test("ambiguous unlimited/capped commands and fractional call limits fail before DB access", () => {
  for (const flag of [
    "--max-cost-usd",
    "--max-llm-requests",
    "--geocode-limit",
  ]) {
    assert.throws(
      () => parseArgs(["--resume", runId, "--unlimited", flag, "0"]),
      /cannot be combined/,
    );
  }
  for (const flag of ["--max-llm-requests", "--geocode-limit"]) {
    assert.throws(() => parseArgs(["--resume", runId, flag, "1.5"]), /integer/);
  }
  assert.throws(
    () => parseArgs(["--resume", runId, "--unlimited", "--limit", "5"]),
    /preserves scope/,
  );
});
