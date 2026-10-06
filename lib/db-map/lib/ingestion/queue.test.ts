import { test } from "node:test";
import assert from "node:assert/strict";
import { buildImportQueue, queueItem } from "./queue.js";
import type { InventorySnapshot } from "../../sql/ingestion-inventory.js";

const file = {
  id: "file",
  logical_path: "data/poi/example.json",
  source_slug: "example",
  category_slug: "campground",
  disposition: "import",
  format: "json",
  file_sha256: "hash",
  missing_at: null,
  scan_error: null,
  priority: 0,
  notes: "",
  coverage: "unstarted",
  execution: "none",
  freshness: "current",
  next: "Start file ingestion",
  total: null,
  records: 0,
  normalized: 0,
  excluded: 0,
  linked: 0,
  verified: 0,
  degraded: 0,
  invalid: 0,
  normalization_failed: 0,
  resume_run: null,
  latest_run: null,
  commands: { start: "start", resume: null, verify: null, status: null },
} as unknown as InventorySnapshot["files"][number];
const run = {
  id: "full-run",
  options: {},
  status: "paused",
  managed: true,
} as NonNullable<typeof file.resume_run>;
const open = {
  quiescent: true,
  maintenance: { maintenance: false, reason: null },
};

test("queue separates review, verification, work and structural completion", () => {
  assert.equal(queueItem(file).action, "start");
  assert.equal(
    queueItem({ ...file, disposition: "needs_review", category_slug: null })
      .action,
    "review",
  );
  assert.equal(
    queueItem({ ...file, disposition: "supporting" }).action,
    "blocked",
  );
  assert.equal(queueItem({ ...file, coverage: "complete" }).action, "complete");
  assert.deepEqual(
    queueItem({ ...file, coverage: "ready_to_verify" }).run_args,
    [file.logical_path, "--category", "campground", "--from", "report"],
  );
});
test("unfinished full-file work survives a later sample and requires inspection", () => {
  const item = queueItem({
    ...file,
    latest_run: {
      ...run,
      id: "sample",
      options: { limit: 1 },
      status: "succeeded",
    },
    resume_run: run,
  });
  assert.equal(item.action, "inspect");
  assert.equal(item.continuation_run_id, "full-run");
  assert.deepEqual(item.resume_args, ["--resume", "full-run"]);
  assert.equal(item.run_args, null);
  assert.match(item.inspect!, /full-run/);
  const sample = queueItem({
    ...file,
    latest_run: run,
    resume_run: { ...run, options: { limit: 1 } },
  });
  assert.equal(sample.action, "start");
  assert.equal(sample.resume_args, null);
});
test("errors and missing input cannot become automatic retries", () => {
  for (const changes of [
    { invalid: 1 },
    { normalization_failed: 1 },
    { execution: "suspected_interrupted" },
  ])
    assert.equal(queueItem({ ...file, ...changes }).action, "inspect");
  assert.equal(
    queueItem({ ...file, missing_at: new Date() }).action,
    "blocked",
  );
  assert.equal(queueItem({ ...file, format: "kmz" }).action, "blocked");
});
test("maintenance or uncertain process state suppresses launch recommendations", () => {
  const snapshot = { files: [file], inspectedAt: "now" } as InventorySnapshot;
  assert.equal(buildImportQueue(snapshot, open).next?.action, "start");
  assert.equal(
    buildImportQueue(snapshot, { ...open, quiescent: false }).next,
    null,
  );
  assert.equal(
    buildImportQueue(snapshot, {
      ...open,
      maintenance: { maintenance: true, reason: "repair" },
    }).admission.launch_allowed,
    false,
  );
});
