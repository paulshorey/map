/**
 * Ingestion pipeline configuration — reads env with documented defaults (M0).
 */

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable: ${key}`);
}

function envOptional(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : fallback;
}

function envNumber(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${key}: ${v}`);
  return n;
}

export function readLlmConfig(variables: NodeJS.ProcessEnv = process.env) {
  const thinkingBudgetTokens = Number(
    variables.LLM_THINKING_BUDGET_TOKENS || 2048,
  );
  if (
    !Number.isSafeInteger(thinkingBudgetTokens) ||
    thinkingBudgetTokens < 1024
  ) {
    throw new Error("LLM_THINKING_BUDGET_TOKENS must be an integer >= 1024");
  }
  return {
    provider: variables.LLM_PROVIDER || "fireworks",
    model:
      variables.LLM_MODEL || "accounts/fireworks/models/deepseek-v4p1-flash",
    baseUrl: (
      variables.LLM_BASE_URL || "https://api.fireworks.ai/inference/v1"
    ).replace(/\/+$/, ""),
    thinkingBudgetTokens,
    apiKey: () => env("FIREWORKS_API_KEY"),
  };
}

export const ingestConfig = {
  geocoder: {
    provider: envOptional("GEOCODER_PROVIDER", "locationiq"),
    apiKey: () => env("LOCATIONIQ_API_KEY"),
  },
  embeddings: {
    provider: envOptional("EMBEDDINGS_PROVIDER", "jina"),
    model: envOptional("EMBEDDINGS_MODEL", "jina-embeddings-v3"),
    dim: envNumber("EMBEDDINGS_DIM", 384),
    apiKey: () => env("JINA_API_KEY"),
  },
  llm: readLlmConfig(),
  match: {
    tHigh: envNumber("INGEST_MATCH_T_HIGH", 0.85),
    tLow: envNumber("INGEST_MATCH_T_LOW", 0.55),
    proximityMergeDeg: envNumber("INGEST_PROXIMITY_MERGE_DEG", 0.0055),
    nameBlockKm: envNumber("INGEST_NAME_BLOCK_KM", 25),
    centroidCityM: envNumber("CENTROID_CITY_M", 100),
    centroidCountryM: envNumber("CENTROID_COUNTRY_M", 2000),
    centroidCityBandM: envNumber("CENTROID_CITY_BAND_M", 400),
    reverseCityKm: envNumber("REVERSE_CITY_KM", 15),
  },
  extract: {
    batchSize: 500,
  },
  embed: {
    batchSize: envNumber("EMBED_BATCH_SIZE", 32),
  },
} as const;
