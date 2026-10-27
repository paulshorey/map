import { storedPrecisionEvidence } from "../../lib/ingestion/geocode-precision.js";
import { validPoint } from "../../lib/ingestion/location-points.js";
import type { AssessmentInput } from "./location-assessment.js";

/** Read-only supplement, separate from immutable assessment policy/version/hash. */
export function precisionDiagnostics(input: AssessmentInput | null) {
  const forward = input?.validation?.forward as
    | { result?: unknown }
    | undefined;
  const hit = forward?.result;
  if (!validPoint(hit)) return null;
  const result = hit as Record<string, unknown>;
  return {
    ...storedPrecisionEvidence(result, "legacy_artifact"),
    raw_response_available:
      !!result.raw_response && typeof result.raw_response === "object",
  };
}
