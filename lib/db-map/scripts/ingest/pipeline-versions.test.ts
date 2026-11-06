import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PIPELINE_VERSIONS,
  compatibleCheckpointVersions,
  resumePipelineUpgrade,
} from "./pipeline-versions.js";

test("only checkpoints of the exact current pipeline resume; older ones are re-ingested", () => {
  assert.deepEqual(compatibleCheckpointVersions(), []);
  assert.equal(
    resumePipelineUpgrade(Object.fromEntries(Object.entries(PIPELINE_VERSIONS).reverse())),
    null,
  );
  for (const versions of [
    { ...PIPELINE_VERSIONS, normalizer: "hybrid-v5" },
    { ...PIPELINE_VERSIONS, matcher: "matcher-v3" },
    { ...PIPELINE_VERSIONS, geocode: "locationiq-location-v3" },
    { ...PIPELINE_VERSIONS, canonicalBuilder: "canonical-build-v6" },
    { ...PIPELINE_VERSIONS, futureStage: "new" },
    {},
  ])
    assert.throws(() => resumePipelineUpgrade(versions), /Pipeline versions changed/);
});
