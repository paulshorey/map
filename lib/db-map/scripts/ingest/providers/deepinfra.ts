/**
 * DeepInfra chat client (OpenAI-compatible API). Used for prose-date conversion
 * (M5 data-quality contract) and M8 match adjudication / description fusion.
 */
import { ingestConfig } from "../config.js";

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(message);
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

const sleep = (ms: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

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

/** OpenAI-compatible DeepInfra completion with bounded retry and telemetry. */
export async function completeChat(opts: ChatOptions): Promise<ChatResult> {
  const { model, baseUrl, apiKey } = ingestConfig.llm;
  const retries = opts.retries ?? 2;
  let lastError: LlmError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey()}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: opts.maxTokens ?? 1024,
          messages: messagesFor(opts),
          ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
          thinking: { type: "disabled" },
        }),
      });

      const raw = await res.text();
      let body: {
        model?: string;
        choices?: { message?: { content?: string }; finish_reason?: string | null }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          total_tokens?: number;
          estimated_cost?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
        error?: { message?: string };
      };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        throw new LlmError(`Invalid JSON response (status ${res.status})`, res.status >= 500, res.status);
      }

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        throw new LlmError(
          body.error?.message ?? `Unexpected status ${res.status}`,
          retryable,
          res.status,
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
          cachedTokens: body.usage?.prompt_tokens_details?.cached_tokens ?? null,
          completionTokens: body.usage?.completion_tokens ?? null,
          totalTokens: body.usage?.total_tokens ?? null,
          estimatedCost: body.usage?.estimated_cost ?? null,
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
      await sleep(Math.min(10_000, 500 * 2 ** attempt + Math.floor(Math.random() * 250)));
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
