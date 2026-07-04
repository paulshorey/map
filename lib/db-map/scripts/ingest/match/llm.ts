import { chat } from "../providers/deepinfra.js";

const MATCH_SYSTEM_PROMPT =
  "You are a POI deduplication judge. Reply only with valid JSON shaped like {\"same_place\":true|false,\"reason\":\"one concise sentence\"}. Be conservative: same real-world place only.";

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

function parseJsonObject(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("LLM did not return JSON");
  }
}

export async function adjudicateMatch(input: LlmMatchInput): Promise<LlmMatchDecision> {
  const text = await chat({
    system: MATCH_SYSTEM_PROMPT,
    user: JSON.stringify(input),
    maxTokens: 256,
  });
  const parsed = parseJsonObject(text) as { same_place?: unknown; reason?: unknown };
  if (typeof parsed.same_place !== "boolean") {
    throw new Error("LLM JSON missing boolean same_place");
  }
  return {
    samePlace: parsed.same_place,
    reason: typeof parsed.reason === "string" ? parsed.reason : "No reason provided.",
  };
}

