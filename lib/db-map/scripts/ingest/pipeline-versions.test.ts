import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PIPELINE_VERSIONS,
  compatibleCheckpointVersions,
  resumePipelineUpgrade,
} from "./pipeline-versions.js";

const legacy = {
  ...PIPELINE_VERSIONS,
  normalizer: "hybrid-v3",
  prompt: "poi-normalize-v2",
};
test("GLM upgrade preserves old checkpoints only for the exact reviewed version pairs", () => {
  assert.deepEqual(resumePipelineUpgrade(legacy), {
    from: legacy,
    to: PIPELINE_VERSIONS,
  });
  const interim = {
    ...PIPELINE_VERSIONS,
    normalizer: "hybrid-v4",
    prompt: "poi-normalize-v3",
  };
  assert.deepEqual(resumePipelineUpgrade(interim), {
    from: interim,
    to: PIPELINE_VERSIONS,
  });
  const priorGlm = { ...PIPELINE_VERSIONS, normalizer: "hybrid-v5" };
  assert.deepEqual(resumePipelineUpgrade(priorGlm), { from: priorGlm, to: PIPELINE_VERSIONS });
  assert.deepEqual(compatibleCheckpointVersions(), [legacy, interim, priorGlm]);
  assert.equal(
    resumePipelineUpgrade(
      Object.fromEntries(Object.entries(PIPELINE_VERSIONS).reverse()),
    ),
    null,
  );
  for (const versions of [
    { ...legacy, schema: "changed" },
    { ...legacy, extractor: "changed" },
    { ...legacy, matcher: "changed" },
    { ...legacy, canonicalBuilder: "changed" },
    { ...legacy, prompt: PIPELINE_VERSIONS.prompt },
    { ...legacy, normalizer: "hybrid-v2" },
    { ...legacy, futureStage: "new" },
    { ...interim, prompt: "poi-normalize-v2" },
    { ...interim, embedding: "changed" },
    { ...priorGlm, prompt: "poi-normalize-v3" },
    {},
  ])
    assert.throws(
      () => resumePipelineUpgrade(versions),
      /Pipeline versions changed/,
    );
});
