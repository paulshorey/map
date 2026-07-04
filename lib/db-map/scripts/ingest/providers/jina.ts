/**
 * Jina AI embeddings client (M7). Provider is isolated so the model or vendor
 * can be swapped without touching the embed loop.
 */
import { ingestConfig } from "../config.js";

const BASE_URL = "https://api.jina.ai/v1/embeddings";

interface JinaEmbeddingRow {
  index: number;
  embedding: number[];
}

interface JinaResponse {
  data?: JinaEmbeddingRow[];
  detail?: string;
  message?: string;
}

export class EmbedError extends Error {}

/**
 * Embed one or more texts. Returns vectors in the same order as `texts`.
 * Throws EmbedError on transient/unexpected failures.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { model, dim, apiKey } = ingestConfig.embeddings;
  const key = apiKey();

  let res: Response;
  try {
    res = await fetch(BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        task: "text-matching",
        dimensions: dim,
        input: texts,
      }),
    });
  } catch (err) {
    throw new EmbedError(`Network error: ${(err as Error).message}`);
  }

  const body = (await res.json()) as JinaResponse;

  if (res.status === 429) {
    throw new EmbedError("Rate limited (429)");
  }
  if (!res.ok) {
    const msg = body.detail ?? body.message ?? `Unexpected status ${res.status}`;
    throw new EmbedError(msg);
  }

  const rows = body.data;
  if (!rows || rows.length !== texts.length) {
    throw new EmbedError(`Expected ${texts.length} embeddings, got ${rows?.length ?? 0}`);
  }

  const ordered = new Array<number[]>(texts.length);
  for (const row of rows) {
    if (row.index < 0 || row.index >= texts.length) {
      throw new EmbedError(`Invalid embedding index ${row.index}`);
    }
    if (!Array.isArray(row.embedding) || row.embedding.length !== dim) {
      throw new EmbedError(
        `Embedding at index ${row.index} has length ${row.embedding?.length ?? 0}, expected ${dim}`,
      );
    }
    ordered[row.index] = row.embedding;
  }

  for (let i = 0; i < ordered.length; i++) {
    if (!ordered[i]) {
      throw new EmbedError(`Missing embedding at index ${i}`);
    }
  }

  return ordered;
}
