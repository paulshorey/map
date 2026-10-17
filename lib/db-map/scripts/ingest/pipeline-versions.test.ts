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
  assert.deepEqual(resumePipelineUpgrade(priorGlm), {
    from: priorGlm,
    to: PIPELINE_VERSIONS,
  });
  assert.deepEqual(compatibleCheckpointVersions().slice(0, 3), [
    legacy,
    interim,
    priorGlm,
  ]);
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

test("location upgrade preserves historical structural proofs but reruns location binding on resume", () => {
  const old = {
    ...PIPELINE_VERSIONS,
    geocode: "locationiq-v1",
    canonicalBuilder: "canonical-build-v1",
  };
  assert.deepEqual(resumePipelineUpgrade(old), {
    from: old,
    to: PIPELINE_VERSIONS,
  });
  assert.throws(
    () => resumePipelineUpgrade({ ...old, geocode: "unknown-provider" }),
    /Pipeline versions changed/,
  );
});

for (const [normalizer, prompt] of [
  ["hybrid-v3", "poi-normalize-v2"],
  ["hybrid-v4", "poi-normalize-v3"],
  ["hybrid-v5", "poi-normalize-v4"],
  ["hybrid-v6", "poi-normalize-v4"],
])
  test(`canonical origin upgrade accepts reviewed ${normalizer} v3 checkpoint`, () => {
    const old = {
      ...PIPELINE_VERSIONS,
      normalizer,
      prompt,
      geocode: "locationiq-location-v3",
      canonicalBuilder: "canonical-build-v3",
    };
    assert.deepEqual(resumePipelineUpgrade(old), {
      from: old,
      to: PIPELINE_VERSIONS,
    });
    assert.throws(
      () => resumePipelineUpgrade({ ...old, geocode: "unknown" }),
      /Pipeline versions changed/,
    );
  });
