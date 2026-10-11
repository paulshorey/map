import { ingestConfig } from "../config.js";
import { stableHash } from "../hash.js";
import { chatRequestSettings } from "../providers/llm.js";

export const NORMALIZATION_MAX_OUTPUT_TOKENS = 1800;

/** Keep deterministic cache keys intact; distinguish provider-backed request behavior. */
export function normalizationInputHash(
  input: Record<string, unknown>,
  noLlm: boolean,
): string {
  return stableHash({
    ...input,
    ...(noLlm
      ? {}
      : {
          llm: {
            provider: ingestConfig.llm.provider,
            baseUrl: ingestConfig.llm.baseUrl,
            ...chatRequestSettings(NORMALIZATION_MAX_OUTPUT_TOKENS),
          },
        }),
  });
}
