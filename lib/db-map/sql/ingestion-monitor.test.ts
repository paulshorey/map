import assert from "node:assert/strict";
import { test } from "node:test";
import { stageProgress } from "./ingestion-monitor.js";

test("stage rates use the elapsed time of a young stage", () => {
  const counts = [
    { state: "succeeded", records: 60 },
    { state: "pending", records: 140 },
  ];
  const young = stageProgress("normalize", counts, 60, 1);
  assert.equal(young.per_minute, 60);
  assert.equal(young.eta_minutes, 3);
  const mature = stageProgress("normalize", counts, 60, 40);
  assert.equal(mature.per_minute, 4);
  assert.equal(mature.eta_minutes, 35);
});

test("a finished stage has a zero ETA and an idle unfinished stage an unknown one", () => {
  assert.equal(stageProgress("embed", [{ state: "succeeded", records: 5 }], 0).eta_minutes, 0);
  assert.equal(stageProgress("embed", [{ state: "pending", records: 5 }], 0).eta_minutes, null);
});
