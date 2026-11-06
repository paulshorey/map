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
  geocode: "locationiq-location-v4",
  embedding: "jina-match-v1",
  matcher: "matcher-v4",
  canonicalBuilder: "canonical-build-v8",
} as const;

/**
 * Reviewed older version sets whose checkpoints may resume under the current code. Empty by
 * policy: data produced by older pipeline logic is never upgraded in place; it is purged and
 * re-ingested from the raw captures (ingest:staleness, ingest:purge, ingest:clean). A future
 * change that is genuinely checkpoint-compatible may list its predecessor here after review.
 */
export function compatibleCheckpointVersions(): Record<string, string>[] {
  return [];
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
      Object.entries(versions).every(([key, value]) => previous[key] === value),
    );
  if (!compatible)
    throw new Error(
      "Pipeline versions changed; start a new file run instead of resuming an old scope",
    );
  return { from: previous, to: PIPELINE_VERSIONS };
}
