import { test } from "node:test";
import assert from "node:assert/strict";
import { assessFile, shellQuote, type Evidence } from "./assessment.js";
const fixture: Evidence = {
  missing_at: null,
  scan_error: null,
  disposition: "import",
  category_slug: "campground",
  format: "csv",
  file_sha256: "hash",
  has_history: true,
  current_version: true,
  extraction_complete: true,
  records: 100,
  ready: 100,
  verified: 100,
  invalid: 0,
  normalization_failed: 0,
  normalized: 100,
  excluded: 0,
  coordinates: 100,
  embedded: 100,
  linked: 100,
  latest_run: null,
};
test("whole file completion needs extraction, readiness and verification", () => {
  assert.equal(assessFile(fixture).coverage, "complete");
  assert.equal(
    assessFile({ ...fixture, verified: 1 }).coverage,
    "ready_to_verify",
  );
  assert.equal(
    assessFile({ ...fixture, ready: 1, verified: 1 }).coverage,
    "partial",
  );
  const sample = assessFile({
    ...fixture,
    extraction_complete: false,
    records: 1,
    ready: 1,
    verified: 1,
  });
  assert.equal(sample.coverage, "partial");
  assert.equal(sample.total, null);
  assert.equal(sample.percent, null);
});
test("changed, untracked, unsupported and missing are separate signals", () => {
  assert.equal(
    assessFile({ ...fixture, current_version: false }).freshness,
    "changed",
  );
  assert.equal(
    assessFile({ ...fixture, current_version: false }).coverage,
    "unstarted",
  );
  assert.equal(
    assessFile({ ...fixture, current_version: false, has_history: false })
      .freshness,
    "current",
  );
  assert.equal(assessFile({ ...fixture, format: "kmz" }).coverage, "unknown");
  assert.equal(
    assessFile({ ...fixture, missing_at: new Date() }).freshness,
    "missing",
  );
  assert.equal(
    assessFile({ ...fixture, scan_error: "changed while scanning" }).coverage,
    "unknown",
  );
  assert.equal(
    assessFile({ ...fixture, records: 0, ready: 0, verified: 0 }).coverage,
    "partial",
  );
});
test("a stale or legacy running row never proves that a worker is alive", () => {
  const run = {
    id: "id",
    managed: true,
    status: "running",
    current_stage: "normalize",
    heartbeat_at: new Date(1000),
    options: { limit: 1 },
    file_sha256: "hash",
    extractor_version: "v1",
    pipeline_versions: {},
    category_slug: "campground",
    stop_requested: false,
    fatal_error: null,
  };
  assert.equal(
    assessFile({ ...fixture, latest_run: run }, 35000).execution,
    "suspected_interrupted",
  );
  assert.equal(
    assessFile({ ...fixture, latest_run: run }, 2000).execution,
    "running",
  );
  assert.equal(
    assessFile({ ...fixture, latest_run: { ...run, managed: false } }, 2000)
      .execution,
    "suspected_interrupted",
  );
});
test("shell commands quote arbitrary filenames literally", () => {
  assert.equal(shellQuote("file's $(name).csv"), "'file'\\''s $(name).csv'");
});
