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
