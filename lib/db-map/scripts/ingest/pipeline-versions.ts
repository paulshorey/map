import {
  EXAMPLES_VERSION,
  NORMALIZER_VERSION,
  PROMPT_VERSION,
  SCHEMA_VERSION,
} from "./normalize/contracts.js";

export const PIPELINE_VERSIONS = {
  orchestrator: "ingest-run-v1",
  extractor: "extract-observation-v1",
  normalizer: NORMALIZER_VERSION,
  prompt: PROMPT_VERSION,
  schema: SCHEMA_VERSION,
  examples: EXAMPLES_VERSION,
  geocode: "locationiq-v1",
  embedding: "jina-match-v1",
  matcher: "matcher-v1",
  canonicalBuilder: "canonical-build-v1",
} as const;

/** Only reviewed checkpoint versions; older proofs also require a fresh full-run audit in inventory. */
export function compatibleCheckpointVersions(): Record<string, string>[] {
  if (
    PIPELINE_VERSIONS.normalizer !== "hybrid-v6" ||
    PIPELINE_VERSIONS.prompt !== "poi-normalize-v4"
  )
    return [];
  return [
    { ...PIPELINE_VERSIONS, normalizer: "hybrid-v3", prompt: "poi-normalize-v2" },
    { ...PIPELINE_VERSIONS, normalizer: "hybrid-v4", prompt: "poi-normalize-v3" },
    { ...PIPELINE_VERSIONS, normalizer: "hybrid-v5", prompt: "poi-normalize-v4" },
  ];
}

/** This source-preserving upgrade changes pending normalization only, not checkpoint validity. */
export function resumePipelineUpgrade(previous: Record<string, unknown>): {
  from: Record<string, unknown>;
  to: typeof PIPELINE_VERSIONS;
} | null {
  const expected = Object.keys(PIPELINE_VERSIONS);
  const exact =
    expected.length === Object.keys(previous).length &&
    Object.entries(PIPELINE_VERSIONS).every(
      ([key, value]) => previous[key] === value,
    );
  if (exact) return null;
  const compatible =
    expected.length === Object.keys(previous).length &&
    compatibleCheckpointVersions().some((versions) =>
      Object.entries(versions).every(
        ([key, value]) => previous[key] === value,
      ),
    );
  if (!compatible)
    throw new Error(
      "Pipeline versions changed; start a new file run instead of resuming an old scope",
    );
  return { from: previous, to: PIPELINE_VERSIONS };
}
