/**
 * DeepInfra chat client (OpenAI-compatible API). Used for prose-date conversion
 * (M5 data-quality contract) and M8 match adjudication / description fusion.
 */
import { ingestConfig } from "../config.js";

export class LlmError extends Error {}

export interface ChatOptions {
  system: string;
  user: string;
  maxTokens?: number;
}

/** Single-turn chat completion at temperature 0. Returns the raw text content. */
export async function chat(opts: ChatOptions): Promise<string> {
  const { model, baseUrl, apiKey } = ingestConfig.llm;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey()}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: opts.maxTokens ?? 256,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
    });
  } catch (err) {
    throw new LlmError(`Network error: ${(err as Error).message}`);
  }

  if (res.status === 429) throw new LlmError("Rate limited (429)");
  if (!res.ok) throw new LlmError(`Unexpected status ${res.status}`);

  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = body.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new LlmError("Empty completion");
  }
  return content;
}
