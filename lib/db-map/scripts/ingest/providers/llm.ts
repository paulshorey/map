/**
 * OpenAI-compatible chat client for Fireworks AI. Used for prose-date
 * conversion (M5 data-quality contract), hybrid normalization, and M8 match
 * adjudication / description fusion.
 *
 * Endpoint: POST {baseUrl}/chat/completions
 * Docs: https://docs.fireworks.ai/guides/querying-text-models
 */
import { ingestConfig } from "../config.js";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JsonSchemaResponseFormat {
  type: "json_schema";
  json_schema: {
    name: string;
    strict: boolean;
    schema: Record<string, unknown>;
  };
}

export interface ChatOptions {
  system?: string;
  user?: string;
  messages?: ChatMessage[];
  maxTokens?: number;
  responseFormat?: JsonSchemaResponseFormat | { type: "json_object" };
  timeoutMs?: number;
  retries?: number;
}

export interface ChatResult {
  content: string;
  model: string;
  finishReason: string | null;
  usage: {
    promptTokens: number | null;
    cachedTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    estimatedCost: number | null;
  };
  latencyMs: number;
}

/**
 * Fireworks serverless list prices for DeepSeek V4.1 Flash
 * (https://fireworks.ai/models/deepseek-ai/deepseek-v4p1-flash):
 * $0.22 / $0.007 / $0.66 per 1M tokens (input / cached input / output).
 * Used only when the API omits `usage.estimated_cost`.
 */
const FIREWORKS_USD_PER_MTOK = {
  input: 0.22,
  cachedInput: 0.007,
  output: 0.66,
} as const;

const sleep = (ms: number) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

export function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return seconds >= 0 ? Math.round(seconds * 1_000) : undefined;
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function messagesFor(opts: ChatOptions): ChatMessage[] {
  if (opts.messages?.length) return opts.messages;
  if (opts.system === undefined || opts.user === undefined) {
    throw new Error("chat requires messages[] or system + user");
  }
  return [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
}

function providerErrorMessage(
  body: {
    error?: { message?: string } | string;
    message?: string;
    detail?: unknown;
  },
  status: number,
): string {
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (
    typeof body.error === "object" &&
    typeof body.error.message === "string" &&
    body.error.message.trim()
  ) {
    return body.error.message;
  }
  if (typeof body.message === "string" && body.message.trim()) {
    return body.message;
  }
  if (typeof body.detail === "string" && body.detail.trim()) return body.detail;
  if (Array.isArray(body.detail) && body.detail.length > 0) {
    return body.detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (
          item &&
          typeof item === "object" &&
          "msg" in item &&
          typeof item.msg === "string"
        ) {
          return item.msg;
        }
        return JSON.stringify(item);
      })
      .join("; ");
  }
  return `Unexpected status ${status}`;
}

function estimateCostUsd(usage: {
  estimated_cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}): number | null {
  if (typeof usage.estimated_cost === "number") return usage.estimated_cost;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  if (prompt == null || completion == null) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const uncached = Math.max(0, prompt - cached);
  return (
    (uncached * FIREWORKS_USD_PER_MTOK.input +
      cached * FIREWORKS_USD_PER_MTOK.cachedInput +
      completion * FIREWORKS_USD_PER_MTOK.output) /
    1_000_000
  );
}

/** OpenAI-compatible Fireworks completion with bounded retry and telemetry. */
export async function completeChat(opts: ChatOptions): Promise<ChatResult> {
  const { model, baseUrl, apiKey } = ingestConfig.llm;
  // Configuration failures are not transient network failures.
  const authorization = `Bearer ${apiKey()}`;
  const messages = messagesFor(opts);
  const retries = opts.retries ?? 2;
  let lastError: LlmError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      opts.timeoutMs ?? 180_000,
    );
    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: opts.maxTokens ?? 1024,
          messages,
          ...(opts.responseFormat
            ? { response_format: opts.responseFormat }
            : {}),
          // DeepSeek V4.x defaults to thinking on Fireworks; disable to keep
          // completions short and parseable. Same shape as Anthropic-compatible
          // `thinking` and equivalent to `reasoning_effort: "none"`.
          thinking: { type: "disabled" },
        }),
      });

      const raw = await res.text();
      let body: {
        model?: string;
        choices?: {
          message?: { content?: string };
          finish_reason?: string | null;
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          estimated_cost?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
        error?: { message?: string } | string;
        message?: string;
        detail?: unknown;
      };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        throw new LlmError(
          `Invalid JSON response (status ${res.status})`,
          res.status === 429 || res.status >= 500,
          res.status,
          retryAfterMs(res.headers.get("retry-after")),
        );
      }

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new LlmError(
          providerErrorMessage(body, res.status),
          retryable,
          res.status,
          retryAfterMs(res.headers.get("retry-after")),
        );
      }

      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      const finishReason = choice?.finish_reason ?? null;
      if (typeof content !== "string" || content.length === 0) {
        throw new LlmError("Empty completion", true);
      }
      if (finishReason === "length") {
        throw new LlmError("Completion truncated by max_tokens", true);
      }

      return {
        content,
        model: body.model ?? model,
        finishReason,
        usage: {
          promptTokens: body.usage?.prompt_tokens ?? null,
          cachedTokens:
            body.usage?.prompt_tokens_details?.cached_tokens ?? null,
          completionTokens: body.usage?.completion_tokens ?? null,
          totalTokens: body.usage?.total_tokens ?? null,
          estimatedCost: body.usage ? estimateCostUsd(body.usage) : null,
        },
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      const normalized =
        error instanceof LlmError
          ? error
          : new LlmError(
              error instanceof Error && error.name === "AbortError"
                ? "Request timed out"
                : `Network error: ${(error as Error).message}`,
              true,
            );
      lastError = normalized;
      if (!normalized.retryable || attempt === retries) throw normalized;
      // A long provider cooldown needs managed recovery; never retry earlier than requested.
      if (
        normalized.retryAfterMs !== undefined &&
        normalized.retryAfterMs > 60_000
      )
        throw normalized;
      const backoffMs =
        normalized.retryAfterMs ??
        (normalized.status === 429
          ? 2_000 * 2 ** attempt
          : 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
      await sleep(Math.min(60_000, backoffMs));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new LlmError("Completion failed");
}

/** Compatibility single-turn helper used by date/match/description code. */
export async function chat(opts: ChatOptions): Promise<string> {
  return (await completeChat(opts)).content;
}
