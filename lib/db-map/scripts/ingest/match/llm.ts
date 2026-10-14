import { currentAttempt } from "../execution.js";
import {
  completeChat,
  LlmError,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
} from "../providers/llm.js";

const MATCH_SYSTEM_PROMPT =
  'You are a POI deduplication judge. Reply only with valid JSON shaped like {"same_place":true|false,"reason":"one concise sentence"}. Decide whether the records describe the same real-world place, visitor complex, or contained feature cluster; nearby same-category places and same distinctive names are strong evidence, but adjacent independent businesses or venues can remain different.';

export interface LlmMatchInput {
  current: unknown;
  candidate: unknown;
  distance_m: number;
  score: number;
  signals: unknown;
}

export interface LlmMatchDecision {
  samePlace: boolean;
  reason: string;
}

const MATCH_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "poi_match_decision",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["same_place", "reason"],
      properties: {
        same_place: { type: "boolean" },
        reason: { type: "string", minLength: 1, maxLength: 400 },
      },
    },
  },
};

export function parseMatchDecision(text: string): LlmMatchDecision {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Match output must be an object");
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.same_place !== "boolean" ||
    typeof value.reason !== "string" ||
    !value.reason.trim() ||
    value.reason.length > 400 ||
    Object.keys(value).some((key) => !["same_place", "reason"].includes(key))
  ) {
    throw new Error(
      "Match output needs only boolean same_place and a concise nonempty reason",
    );
  }
  return { samePlace: value.same_place, reason: value.reason.trim() };
}

export async function adjudicateMatch(
  input: LlmMatchInput,
  complete: (options: ChatOptions) => Promise<ChatResult> = completeChat,
): Promise<LlmMatchDecision> {
  const messages: ChatMessage[] = [
    { role: "system", content: MATCH_SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify(input) },
  ];
  for (let pass = 0; pass < 2; pass++) {
    currentAttempt()?.execution.check();
    let result: ChatResult | undefined;
    try {
      result = await complete({
        messages,
        responseFormat: MATCH_RESPONSE_FORMAT,
        maxTokens: pass ? 1024 : 512,
        retries: 0,
      });
      return parseMatchDecision(result.content);
    } catch (error) {
      // Authentication, transport, database and unsupported-schema errors retain their
      // existing recovery semantics. Only unusable completed output gets one repair.
      if (error instanceof LlmError) {
        if (
          error.status ||
          error.retryable ||
          !error.result ||
          !/Completion truncated|Empty final/.test(error.message)
        )
          throw error;
        result = error.result;
      } else if (!result) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      currentAttempt()?.execution.recordProviderOutputFailure({
        operation: "match",
        pass: pass + 1,
        provider_call_id: result?.providerCallId,
        content: result?.content ?? "",
        finish_reason: result?.finishReason ?? null,
        error: reason,
      });
      if (pass)
        throw new LlmError(
          `LLM match output validation failed after one repair: ${reason}`,
          false,
          undefined,
          undefined,
          result,
        );
      if (result?.content)
        messages.push({ role: "assistant", content: result.content });
      messages.push({
        role: "user",
        content: `The previous output failed validation: ${reason}. Return one corrected JSON object with exactly same_place (boolean) and reason (one concise sentence, at most 400 characters). Reassess the original records; do not copy an unvalidated decision. Do not explain the formatting.`,
      });
    }
  }
  throw new Error("Unreachable match repair state");
}
