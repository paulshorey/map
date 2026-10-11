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
    readonly result?: ChatResult,
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
  /** Final-answer allowance; the thinking allowance is added to the wire max_tokens. */
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
 * (https://docs.fireworks.ai/serverless/pricing, checked 2026-10-05):
 * $0.30 / $0.006 / $1.20 per 1M tokens (input / cached input / output).
 * Used only when the API omits `usage.estimated_cost`.
 */
const FIREWORKS_USD_PER_MTOK = {
  input: 0.3,
  cachedInput: 0.006,
  output: 1.2,
} as const;

/** Non-secret settings shared by the request journal and normalization cache identity. */
export function chatRequestSettings(maxTokens = 1024) {
  const { provider, model, baseUrl, thinkingBudgetTokens } = ingestConfig.llm;
  if (
    provider !== "fireworks" ||
    baseUrl !== "https://api.fireworks.ai/inference/v1"
  ) {
    throw new LlmError(
      "Set LLM_PROVIDER=fireworks and LLM_BASE_URL=https://api.fireworks.ai/inference/v1; remove stale DeepInfra overrides",
    );
  }
  if (!model.startsWith("accounts/")) {
    throw new LlmError(
      "LLM_MODEL must use a Fireworks resource ID (accounts/...); remove stale DeepInfra model overrides",
    );
  }
  if (
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    !Number.isSafeInteger(maxTokens + thinkingBudgetTokens)
  ) {
    throw new LlmError(
      "maxTokens must be a positive safe integer with room for the thinking budget",
    );
  }
  return {
    model,
    temperature: 0,
    // V4.1 integers >= 1024 select high thinking AND enforce a thinking-token cap.
    // Do not also send `thinking`: Fireworks rejects both controls together.
    reasoning_effort: thinkingBudgetTokens,
    max_tokens: maxTokens + thinkingBudgetTokens,
    service_tier: "default" as const,
    context_length_exceeded_behavior: "error" as const,
  };
}

export function buildChatRequest(opts: ChatOptions) {
  return {
    ...chatRequestSettings(opts.maxTokens),
    messages: messagesFor(opts),
    ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
  };
}

export function isUnsupportedResponseFormat(error: unknown): boolean {
  return (
    error instanceof LlmError &&
    (error.status === 400 || error.status === 422) &&
    /json_schema|response_format/i.test(error.message) &&
    /not supported|unsupported/i.test(error.message)
  );
}

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
    error?: { message?: string } | string | null;
    message?: string;
    detail?: unknown;
  },
  status: number,
): string {
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (
    body.error !== null &&
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

interface ProviderUsage {
  estimated_cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  total_tokens?: number;
}

function validTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenCount(value: unknown): number | null {
  return validTokens(value) ? value : null;
}

function estimateCostUsd(usage: ProviderUsage, model: string): number | null {
  if (
    typeof usage.estimated_cost === "number" &&
    Number.isFinite(usage.estimated_cost) &&
    usage.estimated_cost >= 0
  )
    return usage.estimated_cost;
  // Never apply this model's rates to an override, router, or dedicated deployment.
  if (model !== "accounts/fireworks/models/deepseek-v4p1-flash") return null;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  if (!validTokens(prompt) || !validTokens(completion)) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  if (!validTokens(cached) || cached > prompt) return null;
  const uncached = prompt - cached;
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
  const request = buildChatRequest(opts);
  const authorization = `Bearer ${apiKey()}`;
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
        body: JSON.stringify(request),
      });

      const raw = await res.text();
      let body: {
        model?: string;
        choices?: {
          message?: { content?: string };
          finish_reason?: string | null;
        }[];
        usage?: ProviderUsage;
        error?: { message?: string } | string | null;
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

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new LlmError(
          `Invalid response object (status ${res.status})`,
          res.status === 429 || res.status >= 500,
          res.status,
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
      const result: ChatResult = {
        content: typeof content === "string" ? content : "",
        model: body.model ?? model,
        finishReason,
        usage: {
          promptTokens: tokenCount(body.usage?.prompt_tokens),
          cachedTokens: tokenCount(
            body.usage?.prompt_tokens_details?.cached_tokens,
          ),
          completionTokens: tokenCount(body.usage?.completion_tokens),
          totalTokens: tokenCount(body.usage?.total_tokens),
          // completion_tokens already includes thinking: do not bill it twice.
          estimatedCost: body.usage
            ? estimateCostUsd(body.usage, body.model ?? model)
            : null,
        },
        latencyMs: Date.now() - started,
      };
      if (finishReason === "length") {
        throw new LlmError(
          "Completion truncated by max_tokens; review output/thinking allowance before retrying",
          false,
          undefined,
          undefined,
          result,
        );
      }
      if (!result.content.trim()) {
        throw new LlmError(
          "Empty final completion",
          false,
          undefined,
          undefined,
          result,
        );
      }
      return result;
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
