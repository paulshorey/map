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
  llm: {
    provider: envOptional("LLM_PROVIDER", "deepinfra"),
    model: envOptional("LLM_MODEL", "deepseek-ai/DeepSeek-V4-Flash"),
    baseUrl: "https://api.deepinfra.com/v1/openai",
    apiKey: () => env("DEEPINFRA_API_KEY"),
  },
  match: {
    tHigh: envNumber("INGEST_MATCH_T_HIGH", 0.85),
    tLow: envNumber("INGEST_MATCH_T_LOW", 0.55),
  },
  extract: {
    batchSize: 500,
  },
  embed: {
    batchSize: envNumber("EMBED_BATCH_SIZE", 32),
  },
} as const;
