import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { ingestConfig, readLlmConfig } from "../config.js";
import { stableHash } from "../hash.js";
import { normalizationInputHash } from "../normalize/cache.js";
import { withAttemptContext } from "../execution.js";
import { isTransientProviderError } from "../provider-recovery.js";
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
  // Existing pricing fixtures explicitly exercise Standard; production defaults to Priority.
  Object.assign(
    ingestConfig.llm,
    readLlmConfig({ LLM_SERVICE_TIER: "default" }),
  );
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

test("database cancellation of an in-flight fetch preserves the systemic error", async () => {
  const controller = new AbortController();
  const databaseError = Object.assign(
    new Error("timeout exceeded when trying to connect"),
    { code: "database_pool_checkout_timeout" },
  );
  const ctx = {
    runId: "fixture",
    attemptId: "fixture",
    stage: "match",
    execution: {
      id: "fixture",
      stopped: false,
      abortController: controller,
      db: { query: async () => ({ rows: [] }) },
    },
  } as any;
  globalThis.fetch = async () => {
    calls++;
    controller.abort(databaseError);
    throw databaseError;
  };
  await withAttemptContext(ctx, () =>
    assert.rejects(
      completeChat({ system: "fixture", user: "fixture" }),
      (error) => {
        assert.equal(error, databaseError);
        assert.equal(isTransientProviderError(error), false);
        return true;
      },
    ),
  );
  assert.equal(calls, 1);
});

test("an independent fetch transport failure remains provider-retryable", async () => {
  const ctx = {
    runId: "fixture",
    attemptId: "fixture",
    stage: "match",
    execution: {
      id: "fixture",
      stopped: false,
      abortController: new AbortController(),
      db: { query: async () => ({ rows: [] }) },
    },
  } as any;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("socket hang up");
  };
  await withAttemptContext(ctx, () =>
    assert.rejects(
      completeChat({ system: "fixture", user: "fixture" }),
      (error) => {
        assert.equal(isTransientProviderError(error), true);
        return true;
      },
    ),
  );
  assert.equal(calls, 1);
});

test("defaults pin Fireworks GLM and reject unbounded/ambiguous thinking settings", () => {
  assert.equal(readLlmConfig({}).thinkingBudgetTokens, 256);
  assert.equal(
    readLlmConfig({}).model,
    "accounts/fireworks/models/glm-5p3-flash",
  );
  assert.equal(
    readLlmConfig({ LLM_THINKING_BUDGET_TOKENS: "4096" }).thinkingBudgetTokens,
    4096,
  );
  for (const value of ["0", "-1", "256.5", "none", "NaN", "Infinity"]) {
    assert.throws(
      () => readLlmConfig({ LLM_THINKING_BUDGET_TOKENS: value }),
      /integer >= 1/,
    );
  }
});

test("Priority is the default admission tier; Standard is explicit and unknown tiers fail closed", () => {
  assert.equal(readLlmConfig({}).serviceTier, "priority");
  assert.equal(
    readLlmConfig({ LLM_SERVICE_TIER: "default" }).serviceTier,
    "default",
  );
  for (const value of ["auto", "fast", "standard", "Priority"]) {
    assert.throws(
      () => readLlmConfig({ LLM_SERVICE_TIER: value }),
      /LLM_SERVICE_TIER/,
    );
  }
  Object.assign(ingestConfig.llm, readLlmConfig({}));
  const body = buildChatRequest({
    system: "fixture",
    user: "fixture",
    maxTokens: 1800,
  });
  assert.equal(body.service_tier, "priority");
  assert.equal(body.model, "accounts/fireworks/models/glm-5p3-flash");
  assert.equal(body.reasoning_effort, 256);
  assert.equal(body.max_tokens, 2056);
});

test("Priority wire requests use tier-aware rates for known models without double-counting thinking", async () => {
  for (const [model, input, cached, output] of [
    ["accounts/fireworks/models/glm-5p3-flash", 0.15, 0.03, 0.5],
    ["accounts/fireworks/models/deepseek-v4p1-flash", 0.3, 0.006, 1.2],
  ] as const) {
    Object.assign(ingestConfig.llm, readLlmConfig({ LLM_MODEL: model }));
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).service_tier, "priority");
      return Response.json(
        completion({
          prompt_tokens: 100,
          completion_tokens: 240,
          prompt_tokens_details: { cached_tokens: 40 },
          completion_tokens_details: { reasoning_tokens: 220 },
        }),
      );
    };
    const result = await completeChat({
      system: "fixture",
      user: "fixture",
      retries: 0,
    });
    assert.equal(
      result.usage.estimatedCost,
      (1.25 * (60 * input + 40 * cached + 240 * output)) / 1_000_000,
    );
    // A missing response field does not prove the provider served Priority.
    assert.equal(result.serviceTier, null);
  }
  assert.equal(calls, 2);
});

test("cost uses the reported served tier and provider cost overrides any fallback", async () => {
  Object.assign(ingestConfig.llm, readLlmConfig({}));
  for (const tier of ["default", "priority", "future-tier"]) {
    respond({
      ...completion({ prompt_tokens: 100, completion_tokens: 20 }),
      service_tier: tier,
    });
    const result = await completeChat({
      system: "fixture",
      user: "fixture",
      retries: 0,
    });
    assert.equal(result.serviceTier, tier);
    const multiplier =
      tier === "default" ? 1 : tier === "priority" ? 1.25 : null;
    assert.equal(
      result.usage.estimatedCost,
      multiplier === null
        ? null
        : (multiplier * (100 * 0.15 + 20 * 0.5)) / 1_000_000,
    );
  }
  for (const cost of [0, 0.05]) {
    respond({
      ...completion({ estimated_cost: cost }),
      service_tier: "future-tier",
    });
    assert.equal(
      (await completeChat({ system: "fixture", user: "fixture", retries: 0 }))
        .usage.estimatedCost,
      cost,
    );
  }
});

test("managed telemetry retains requested and reported tiers, including absent reports and failures", async () => {
  Object.assign(ingestConfig.llm, readLlmConfig({}));
  for (const tier of ["priority", undefined]) {
    for (const fail of [false, true]) {
      const queries: { sql: string; params: any[] }[] = [];
      const ctx = {
        runId: "fixture",
        attemptId: "fixture",
        stage: "normalize",
        execution: {
          id: "fixture",
          stopped: false,
          abortController: new AbortController(),
          db: {
            query: async (sql: string, params: any[]) => {
              queries.push({ sql, params });
              return { rows: [] };
            },
          },
        },
      } as any;
      const body = {
        ...completion({ prompt_tokens: 100, completion_tokens: 20 }),
        service_tier: tier,
      };
      if (fail) body.choices[0]!.finish_reason = "length";
      respond(body);
      await withAttemptContext(ctx, async () => {
        if (fail)
          await assert.rejects(
            completeChat({ system: "fixture", user: "fixture" }),
            /truncated/,
          );
        else await completeChat({ system: "fixture", user: "fixture" });
      });
      const start = queries.find((q) =>
        q.sql.startsWith("INSERT INTO research_ingest_provider_calls("),
      );
      const end = queries.find((q) =>
        q.sql.startsWith("UPDATE research_ingest_provider_calls SET"),
      );
      assert.ok(start);
      assert.ok(end);
      assert.equal(
        JSON.parse(start.params[7]).service_tier_requested,
        "priority",
      );
      assert.equal(
        JSON.parse(end.params[11]).service_tier_requested,
        "priority",
      );
      assert.equal(
        JSON.parse(end.params[11]).service_tier_returned,
        tier ?? null,
      );
      assert.equal(end.params[1], fail ? "failed" : "succeeded");
    }
  }
});

test("rejected Priority requests never silently downgrade to Standard", async () => {
  Object.assign(ingestConfig.llm, readLlmConfig({}));
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.equal(JSON.parse(String(init?.body)).service_tier, "priority");
    return Response.json(
      { error: { message: "Priority unavailable for this account" } },
      { status: 400 },
    );
  };
  await assert.rejects(
    completeChat({ system: "fixture", user: "fixture", retries: 2 }),
    (e: unknown) => e instanceof LlmError && e.status === 400 && !e.retryable,
  );
  assert.equal(calls, 1);
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
  assert.equal(body.max_tokens, 320);
  assert.equal(body.reasoning_effort, 256);
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

test("explicit DeepSeek overrides retain a real hard cap and their own rates", async () => {
  const model = "accounts/fireworks/models/deepseek-v4p1-flash";
  assert.equal(readLlmConfig({ LLM_MODEL: model }).thinkingBudgetTokens, 2048);
  for (const value of ["1", "256", "1000", "1023"]) {
    assert.throws(
      () =>
        readLlmConfig({ LLM_MODEL: model, LLM_THINKING_BUDGET_TOKENS: value }),
      /integer >= 1024/,
    );
  }
  Object.assign(
    ingestConfig.llm,
    readLlmConfig({ LLM_MODEL: model, LLM_SERVICE_TIER: "default" }),
  );
  assert.equal(
    buildChatRequest({ system: "fixture", user: "fixture", maxTokens: 64 })
      .max_tokens,
    2112,
  );
  respond(
    completion({
      prompt_tokens: 100,
      completion_tokens: 240,
      prompt_tokens_details: { cached_tokens: 40 },
    }),
  );
  const result = await completeChat({
    system: "fixture",
    user: "fixture",
    retries: 0,
  });
  assert.equal(
    result.usage.estimatedCost,
    (60 * 0.3 + 40 * 0.006 + 240 * 1.2) / 1_000_000,
  );
});

test("GLM reasoning telemetry accepts the provider output-token details shape", async () => {
  respond(
    completion({
      prompt_tokens: 100,
      completion_tokens: 400,
      output_tokens_details: { reasoning_tokens: 256 },
    }),
  );
  const result = await completeChat({
    system: "fixture",
    user: "fixture",
    retries: 0,
  });
  assert.equal(result.reasoningTokens, 256);
  assert.equal(
    result.usage.estimatedCost,
    (100 * 0.15 + 400 * 0.5) / 1_000_000,
  );
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
    (60 * 0.15 + 40 * 0.03 + 240 * 0.5) / 1_000_000,
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
  for (const model of ["another-model", "toString", "__proto__"]) {
    respond(completion({ prompt_tokens: 100, completion_tokens: 20 }, model));
    assert.equal(
      (await completeChat({ system: "fixture", user: "fixture", retries: 0 }))
        .usage.estimatedCost,
      null,
    );
  }
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
        (100 * 0.15 + 2048 * 0.5) / 1_000_000,
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
    llmMode: "provider",
  };
  const original = normalizationInputHash(input, false);
  assert.equal(normalizationInputHash(input, false), original);
  ingestConfig.llm.thinkingBudgetTokens = 4096;
  assert.notEqual(normalizationInputHash(input, false), original);
  assert.equal(normalizationInputHash(input, true), stableHash(input));
  ingestConfig.llm.thinkingBudgetTokens = 256;
  ingestConfig.llm.model = "accounts/fireworks/models/another-model";
  assert.notEqual(normalizationInputHash(input, false), original);
  assert.equal(normalizationInputHash(input, true), stableHash(input));
});

test("changing admission tiers preserves the exact historical normalization cache identity", () => {
  const input = { rawContentHash: "fixture", llmMode: "provider" };
  const historical = stableHash({
    ...input,
    llm: {
      provider: "fireworks",
      baseUrl: "https://api.fireworks.ai/inference/v1",
      model: "accounts/fireworks/models/glm-5p3-flash",
      temperature: 0,
      reasoning_effort: 256,
      max_tokens: 2056,
      service_tier: "default",
      context_length_exceeded_behavior: "error",
    },
  });
  for (const serviceTier of ["priority", "default"] as const) {
    ingestConfig.llm.serviceTier = serviceTier;
    assert.equal(normalizationInputHash(input, false), historical);
    assert.equal(normalizationInputHash(input, true), stableHash(input));
    assert.equal(
      buildChatRequest({ system: "fixture", user: "fixture" }).service_tier,
      serviceTier,
    );
  }
});
