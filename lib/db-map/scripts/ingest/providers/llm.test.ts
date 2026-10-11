import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ingestConfig, readLlmConfig } from "../config.js";
import { stableHash } from "../hash.js";
import { normalizationInputHash } from "../normalize/cache.js";
import {
  buildChatRequest,
  completeChat,
  isUnsupportedResponseFormat,
  LlmError,
} from "./llm.js";

const originalFetch = globalThis.fetch;
const originalConfig = { ...ingestConfig.llm };
const originalKey = process.env.FIREWORKS_API_KEY;
let calls = 0;

beforeEach(() => {
  Object.assign(ingestConfig.llm, readLlmConfig({}));
  process.env.FIREWORKS_API_KEY = "fixture";
  calls = 0;
  // Fail closed: this suite must never make a real inference request.
  globalThis.fetch = async () => {
    throw new Error("Unexpected unmocked fetch");
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(ingestConfig.llm, originalConfig);
  if (originalKey === undefined) delete process.env.FIREWORKS_API_KEY;
  else process.env.FIREWORKS_API_KEY = originalKey;
});

function respond(body: unknown, status = 200) {
  globalThis.fetch = async () => {
    calls++;
    return Response.json(body, { status });
  };
}
function completion(
  usage?: Record<string, unknown>,
  model = ingestConfig.llm.model,
) {
  return {
    model,
    choices: [
      {
        message: {
          content: '{"ok":true}',
          reasoning_content: "fixture reasoning marker",
        },
        finish_reason: "stop",
      },
    ],
    usage,
  };
}

test("defaults pin Fireworks V4.1 and reject unbounded/ambiguous thinking settings", () => {
  assert.equal(readLlmConfig({}).thinkingBudgetTokens, 2048);
  assert.equal(
    readLlmConfig({}).model,
    "accounts/fireworks/models/deepseek-v4p1-flash",
  );
  assert.equal(
    readLlmConfig({ LLM_THINKING_BUDGET_TOKENS: "4096" }).thinkingBudgetTokens,
    4096,
  );
  for (const value of ["0", "-1", "100", "1023", "1024.5", "NaN", "Infinity"]) {
    assert.throws(
      () => readLlmConfig({ LLM_THINKING_BUDGET_TOKENS: value }),
      /integer >= 1024/,
    );
  }
});

test("short final answers retain a separate thinking allowance and JSON schema", () => {
  const responseFormat = {
    type: "json_schema" as const,
    json_schema: { name: "fixture", strict: true, schema: { type: "object" } },
  };
  const body = buildChatRequest({
    system: "Return JSON",
    user: "fixture",
    maxTokens: 64,
    responseFormat,
  });
  assert.equal(body.max_tokens, 2112);
  assert.equal(body.reasoning_effort, 2048);
  assert.equal(body.service_tier, "default");
  assert.deepEqual(body.response_format, responseFormat);
  assert.equal("thinking" in body, false);
  for (const maxTokens of [0, -1, 1.5, Infinity]) {
    assert.throws(
      () => buildChatRequest({ system: "fixture", user: "fixture", maxTokens }),
      /maxTokens/,
    );
  }
});

test("stale provider/endpoint overrides fail before any request or credential lookup", async () => {
  delete process.env.FIREWORKS_API_KEY;
  for (const change of [
    { provider: "deepinfra" },
    { provider: "fireworks", baseUrl: "https://api.deepinfra.com/v1/openai" },
  ]) {
    Object.assign(ingestConfig.llm, change);
    await assert.rejects(
      completeChat({ system: "fixture", user: "fixture" }),
      /remove stale DeepInfra overrides/,
    );
  }
  assert.equal(calls, 0);
  Object.assign(
    ingestConfig.llm,
    readLlmConfig({ LLM_MODEL: "deepseek-ai/DeepSeek-V4-Flash" }),
  );
  await assert.rejects(
    completeChat({ system: "fixture", user: "fixture" }),
    /Fireworks resource ID/,
  );
});

test("thinking remains separate from final JSON and is counted once in output cost", async () => {
  respond(
    completion({
      prompt_tokens: 100,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens: 240,
      completion_tokens_details: { reasoning_tokens: 220 },
    }),
  );
  const result = await completeChat({
    system: "Return JSON",
    user: "fixture",
    retries: 0,
  });
  assert.equal(result.content, '{"ok":true}');
  assert.equal(
    result.usage.estimatedCost,
    (60 * 0.3 + 40 * 0.006 + 240 * 1.2) / 1_000_000,
  );
  assert.equal(
    JSON.stringify(result).includes("fixture reasoning marker"),
    false,
  );
});

test("provider cost takes precedence, including zero; unknown models remain unknown", async () => {
  for (const cost of [0, 0.05]) {
    respond(completion({ estimated_cost: cost }, "another-model"));
    assert.equal(
      (await completeChat({ system: "fixture", user: "fixture", retries: 0 }))
        .usage.estimatedCost,
      cost,
    );
  }
  respond(
    completion({ prompt_tokens: 100, completion_tokens: 20 }, "another-model"),
  );
  assert.equal(
    (await completeChat({ system: "fixture", user: "fixture", retries: 0 }))
      .usage.estimatedCost,
    null,
  );
});

test("missing or malformed token accounting never produces a fabricated cost", async () => {
  for (const usage of [
    undefined,
    {},
    { prompt_tokens: -1, completion_tokens: 20 },
    {
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 101 },
    },
    { prompt_tokens: "100", completion_tokens: 20 },
  ]) {
    respond(completion(usage));
    assert.equal(
      (await completeChat({ system: "fixture", user: "fixture", retries: 0 }))
        .usage.estimatedCost,
      null,
    );
  }
});

test("reasoning-only truncation stops immediately and retains billable usage", async () => {
  const body = completion({ prompt_tokens: 100, completion_tokens: 2048 });
  body.choices[0]!.message.content = "";
  body.choices[0]!.finish_reason = "length";
  respond(body);
  await assert.rejects(
    completeChat({ system: "fixture", user: "fixture", retries: 2 }),
    (error: unknown) => {
      assert.ok(error instanceof LlmError);
      assert.equal(error.retryable, false);
      assert.match(error.message, /truncated/);
      assert.equal(error.result?.usage.completionTokens, 2048);
      assert.equal(
        error.result?.usage.estimatedCost,
        (100 * 0.3 + 2048 * 1.2) / 1_000_000,
      );
      return true;
    },
  );
  assert.equal(calls, 1);
});

test("empty final answers stop with usage; malformed token counts are null in telemetry", async () => {
  const body = completion({ prompt_tokens: 100, completion_tokens: 100 });
  body.choices[0]!.message.content = " ";
  respond(body);
  await assert.rejects(
    completeChat({ system: "fixture", user: "fixture", retries: 2 }),
    (error: unknown) =>
      error instanceof LlmError &&
      !error.retryable &&
      error.result?.usage.completionTokens === 100,
  );
  assert.equal(calls, 1);
  respond(
    completion({
      prompt_tokens: "invalid",
      completion_tokens: -1,
      total_tokens: 3.5,
    }),
  );
  const result = await completeChat({
    system: "fixture",
    user: "fixture",
    retries: 0,
  });
  assert.equal(result.usage.promptTokens, null);
  assert.equal(result.usage.completionTokens, null);
  assert.equal(result.usage.totalTokens, null);
  assert.equal(result.usage.estimatedCost, null);
});

test("null/validation/payment errors retain status and never become transient network retries", async () => {
  for (const [status, body] of [
    [400, { error: null, detail: "Invalid thinking settings" }],
    [401, null],
    [402, { error: { message: "Insufficient credit" } }],
    [422, { detail: [{ msg: "Invalid schema" }] }],
  ] as const) {
    calls = 0;
    respond(body, status);
    await assert.rejects(
      completeChat({ system: "fixture", user: "fixture", retries: 2 }),
      (error: unknown) =>
        error instanceof LlmError &&
        error.status === status &&
        !error.retryable,
    );
    assert.equal(calls, 1);
  }
});

test("JSON fallback only applies to an explicitly unsupported response format", () => {
  assert.equal(
    isUnsupportedResponseFormat(
      new LlmError("json_schema not supported", false, 400),
    ),
    true,
  );
  for (const error of [
    new LlmError("Invalid schema", false, 400),
    new LlmError("Invalid thinking settings", false, 400),
    new LlmError("response_format unsupported", false, 401),
    new LlmError("Insufficient credit", false, 402),
  ]) {
    assert.equal(isUnsupportedResponseFormat(error), false);
  }
});

test("exact normalization cache identity changes with model/thinking; deterministic keys stay intact", () => {
  const input = {
    rawContentHash: "fixture",
    model: "fixture",
    llmMode: "deepseek",
  };
  const original = normalizationInputHash(input, false);
  assert.equal(normalizationInputHash(input, false), original);
  ingestConfig.llm.thinkingBudgetTokens = 4096;
  assert.notEqual(normalizationInputHash(input, false), original);
  assert.equal(normalizationInputHash(input, true), stableHash(input));
  ingestConfig.llm.thinkingBudgetTokens = 2048;
  ingestConfig.llm.model = "accounts/fireworks/models/another-model";
  assert.notEqual(normalizationInputHash(input, false), original);
  assert.equal(normalizationInputHash(input, true), stableHash(input));
});
