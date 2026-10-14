/**
 * Jina AI embeddings client (M7). Provider is isolated so the model or vendor
 * can be swapped without touching the embed loop.
 */
import { ingestConfig } from "../config.js";
import { currentAttempt } from "../execution.js";
import { LlmError, retryAfterMs } from "./llm.js";
import { beginProviderCall, endProviderCall } from "../provider-telemetry.js";

const BASE_URL = "https://api.jina.ai/v1/embeddings";

interface JinaEmbeddingRow {
  index: number;
  embedding: number[];
}

interface JinaResponse {
  data?: JinaEmbeddingRow[];
  detail?: string;
  message?: string;
  usage?: { total_tokens?: number };
}

export class EmbedError extends LlmError {}

/**
 * Embed one or more texts. Returns vectors in the same order as `texts`.
 * Throws EmbedError on transient/unexpected failures.
 */
export async function embedTexts(
  texts: string[],
  contexts?: NonNullable<ReturnType<typeof currentAttempt>>[],
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const { model, dim, apiKey } = ingestConfig.embeddings;
  const key = apiKey();

  const call = await beginProviderCall("jina", "embed", model, contexts);
  const started = Date.now();
  let res: Response;
  let responseHeaders: Headers | undefined, responseStatus: number | undefined;
  try {
    try {
      res = await fetch(BASE_URL, {
        method: "POST",
        signal: currentAttempt()
          ? AbortSignal.any([
              AbortSignal.timeout(60_000),
              currentAttempt()!.execution.abortController.signal,
            ])
          : AbortSignal.timeout(60_000),
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
      throw new EmbedError(`Network error: ${(err as Error).message}`, true);
    }

    responseHeaders = res.headers;
    responseStatus = res.status;
    let body: JinaResponse;
    try {
      body = (await res.json()) as JinaResponse;
    } catch {
      throw new EmbedError(
        "Invalid provider JSON response",
        res.status === 429 || res.status >= 500,
        res.status,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }

    if (res.status === 429) {
      throw new EmbedError(
        "Rate limited (429)",
        true,
        429,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }
    if (!res.ok) {
      const msg =
        body.detail ?? body.message ?? `Unexpected status ${res.status}`;
      throw new EmbedError(
        msg,
        res.status >= 500,
        res.status,
        retryAfterMs(res.headers.get("retry-after")),
      );
    }

    const rows = body.data;
    if (!rows || rows.length !== texts.length) {
      throw new EmbedError(
        `Expected ${texts.length} embeddings, got ${rows?.length ?? 0}`,
      );
    }

    const ordered = new Array<number[]>(texts.length);
    for (const row of rows) {
      if (
        !Number.isInteger(row.index) ||
        row.index < 0 ||
        row.index >= texts.length ||
        ordered[row.index]
      ) {
        throw new EmbedError(`Invalid embedding index ${row.index}`);
      }
      if (
        !Array.isArray(row.embedding) ||
        row.embedding.length !== dim ||
        row.embedding.some((v) => !Number.isFinite(v))
      ) {
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

    await endProviderCall(call, {
      latencyMs: Date.now() - started,
      status: res.status,
      headers: res.headers,
      promptTokens: body.usage?.total_tokens,
    });
    return ordered;
  } catch (error) {
    await endProviderCall(call, {
      latencyMs: Date.now() - started,
      status: responseStatus,
      headers: responseHeaders,
      error,
    });
    throw error;
  }
}
