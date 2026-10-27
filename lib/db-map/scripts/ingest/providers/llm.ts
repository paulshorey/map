/**
 * OpenAI-compatible chat client for Fireworks AI. Used for prose-date
 * conversion (M5 data-quality contract), hybrid normalization, and M8 match
 * adjudication / description fusion.
 *
 * Endpoint: POST {baseUrl}/chat/completions
 * Docs: https://docs.fireworks.ai/guides/querying-text-models
 */
import { ingestConfig } from "../config.js";
import { llmLimiter } from "../concurrency.js";
import { currentAttempt } from "../execution.js";
import { beginProviderCall, endProviderCall } from "../provider-telemetry.js";

export class LlmError extends Error {
  providerCallId?: string;
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
  /** Provider-ledger purpose; the owning attempt still supplies its actual stage. */
  purpose?: "description_fusion";
  system?: string;
  user?: string;
  messages?: ChatMessage[];
  /** Final-answer allowance; the thinking allowance is added to the wire max_tokens. */
  maxTokens?: number;
  responseFormat?: JsonSchemaResponseFormat | { type: "json_object" };
  timeoutMs?: number;
  retries?: number;
  onResponse?: (headers: Headers, status: number) => void;
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
  reasoningTokens?: number | null;
  providerCallId?: string;
  /** Null when the API does not report which tier actually served the request. */
  serviceTier?: string | null;
}

/**
 * Fireworks standard serverless prices per 1M tokens; Priority is 1.25x for these models
 * (https://docs.fireworks.ai/serverless/pricing, checked 2026-10-14).
 * Used only when the API omits `usage.estimated_cost`.
 */
const FIREWORKS_USD_PER_MTOK: Record<
  string,
  { input: number; cachedInput: number; output: number }
> = {
  "accounts/fireworks/models/glm-5p3-flash": {
    input: 0.15,
    cachedInput: 0.03,
    output: 0.5,
  },
  "accounts/fireworks/models/deepseek-v4p1-flash": {
    input: 0.3,
    cachedInput: 0.006,
    output: 1.2,
  },
};

/** Non-secret wire settings; the normalization cache canonicalizes admission tier separately. */
export function chatRequestSettings(maxTokens = 1024) {
  const { provider, model, baseUrl, thinkingBudgetTokens, serviceTier } =
    ingestConfig.llm;
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
    // GLM accepts a positive thinking-token cap; V4.1 needs >= 1024 for a hard cap.
    // Do not also send `thinking`: Fireworks rejects both controls together.
    reasoning_effort: thinkingBudgetTokens,
    max_tokens: maxTokens + thinkingBudgetTokens,
    service_tier: serviceTier,
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
  completion_tokens_details?: { reasoning_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

function validTokens(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function tokenCount(value: unknown): number | null {
  return validTokens(value) ? value : null;
}

function estimateCostUsd(
  usage: ProviderUsage,
  model: string,
  serviceTier: string,
): number | null {
  if (
    typeof usage.estimated_cost === "number" &&
    Number.isFinite(usage.estimated_cost) &&
    usage.estimated_cost >= 0
  )
    return usage.estimated_cost;
  // Never apply serverless rates to an unknown model, router, or deployment.
  const rates = Object.hasOwn(FIREWORKS_USD_PER_MTOK, model)
    ? FIREWORKS_USD_PER_MTOK[model]
    : undefined;
  if (!rates) return null;
  const multiplier =
    serviceTier === "priority" ? 1.25 : serviceTier === "default" ? 1 : null;
  if (multiplier === null) return null;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  if (!validTokens(prompt) || !validTokens(completion)) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  if (!validTokens(cached) || cached > prompt) return null;
  const uncached = prompt - cached;
  return (
    (multiplier *
      (uncached * rates.input +
        cached * rates.cachedInput +
        completion * rates.output)) /
    1_000_000
  );
}

/** OpenAI-compatible Fireworks completion with bounded retry and telemetry. */
async function completeChatUncontrolled(
  opts: ChatOptions,
): Promise<ChatResult> {
  const { model, baseUrl, apiKey } = ingestConfig.llm;
  // Configuration failures are not transient network failures.
  const request = buildChatRequest(opts);
  const authorization = `Bearer ${apiKey()}`;
  const retries = opts.retries ?? (currentAttempt() ? 0 : 2);
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
        signal: currentAttempt()
          ? AbortSignal.any([
              controller.signal,
              currentAttempt()!.execution.abortController.signal,
            ])
          : controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body: JSON.stringify(request),
      });

      opts.onResponse?.(res.headers, res.status);
      const raw = await res.text();
      let body: {
        model?: string;
        service_tier?: string;
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
        serviceTier:
          typeof body.service_tier === "string" ? body.service_tier : null,
        usage: {
          promptTokens: tokenCount(body.usage?.prompt_tokens),
          cachedTokens: tokenCount(
            body.usage?.prompt_tokens_details?.cached_tokens,
          ),
          completionTokens: tokenCount(body.usage?.completion_tokens),
          totalTokens: tokenCount(body.usage?.total_tokens),
          // completion_tokens already includes thinking: do not bill it twice.
          estimatedCost: body.usage
            ? estimateCostUsd(
                body.usage,
                body.model ?? model,
                body.service_tier ?? request.service_tier,
              )
            : null,
        },
        latencyMs: Date.now() - started,
        reasoningTokens: tokenCount(
          body.usage?.completion_tokens_details?.reasoning_tokens ??
            body.usage?.output_tokens_details?.reasoning_tokens,
        ),
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
      // A scheduler/database failure can abort this fetch with its own Error reason.
      // Preserve that failure; it is not a retryable provider transport outage.
      const executionSignal =
        currentAttempt()?.execution.abortController.signal;
      if (executionSignal?.aborted) executionSignal.throwIfAborted();
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

/** Shared execution-wide admission and common telemetry for every LLM operation. */
export async function completeChat(opts: ChatOptions): Promise<ChatResult> {
  const ctx = currentAttempt();
  if (!ctx) return completeChatUncontrolled(opts);
  const call = await beginProviderCall(
    "fireworks",
    opts.purpose ?? ctx.stage,
    ingestConfig.llm.model,
    undefined,
    ingestConfig.llm.serviceTier,
  );
  const queued = Date.now();
  let headers: Headers | undefined,
    status: number | undefined,
    queueMs = 0;
  try {
    const result = await llmLimiter.run(
      async () => {
        queueMs = Date.now() - queued;
        return completeChatUncontrolled({
          ...opts,
          onResponse: (h, s) => {
            headers = h;
            status = s;
            llmLimiter.observe(
              h,
              s,
              Math.ceil(JSON.stringify(buildChatRequest(opts)).length / 4),
              chatRequestSettings(opts.maxTokens).max_tokens,
              retryAfterMs(h.get("retry-after")),
            );
            opts.onResponse?.(h, s);
          },
        });
      },
      () => ctx.execution.stopped,
    );
    await endProviderCall(call, {
      queueMs,
      latencyMs: result.latencyMs,
      promptTokens: result.usage.promptTokens,
      cachedTokens: result.usage.cachedTokens,
      completionTokens: result.usage.completionTokens,
      reasoningTokens: result.reasoningTokens,
      cost: result.usage.estimatedCost,
      status,
      headers,
      serviceTier: result.serviceTier,
    });
    return { ...result, providerCallId: call?.id };
  } catch (error) {
    if (error instanceof LlmError) {
      error.providerCallId = call?.id;
      if (error.result) error.result.providerCallId = call?.id;
    }
    const result = error instanceof LlmError ? error.result : undefined;
    await endProviderCall(call, {
      queueMs,
      status,
      headers,
      error,
      latencyMs: result?.latencyMs,
      promptTokens: result?.usage.promptTokens,
      cachedTokens: result?.usage.cachedTokens,
      completionTokens: result?.usage.completionTokens,
      reasoningTokens: result?.reasoningTokens,
      cost: result?.usage.estimatedCost,
      serviceTier: result?.serviceTier,
    });
    throw error;
  }
}

/** Compatibility single-turn helper used by date/match/description code. */
export async function chat(opts: ChatOptions): Promise<string> {
  return (await completeChat(opts)).content;
}
