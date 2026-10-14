import { test } from "node:test";
import assert from "node:assert/strict";
import { adjudicateMatch, parseMatchDecision } from "./llm.js";
import {
  LlmError,
  type ChatOptions,
  type ChatResult,
} from "../providers/llm.js";
import { recordFailure } from "../record-scheduler.js";

const input = {
  current: { name: "Camp A" },
  candidate: { name: "Camp B" },
  distance_m: 20,
  score: 0.7,
  signals: {},
};
const result = (content: string): ChatResult => ({
  content,
  model: "fixture",
  finishReason: "stop",
  usage: {
    promptTokens: 1,
    cachedTokens: 0,
    completionTokens: 1,
    totalTokens: 2,
    estimatedCost: 0,
  },
  latencyMs: 1,
});
test("matching requests constrained JSON with room for the final answer", async () => {
  let calls = 0;
  const answer = await adjudicateMatch(input, async (options) => {
    calls++;
    assert.equal(options.retries, 0);
    assert.equal(options.maxTokens, 512);
    assert.equal(options.responseFormat?.type, "json_schema");
    assert.ok(
      JSON.stringify(options.responseFormat).includes(
        '"additionalProperties":false',
      ),
    );
    return result(
      '{"same_place":false,"reason":"Adjacent independent businesses."}',
    );
  });
  assert.equal(calls, 1);
  assert.equal(answer.samePlace, false);
});
test("malformed content gets one contextual repair without accepting a partial decision", async () => {
  const requests: ChatOptions[] = [];
  const answer = await adjudicateMatch(input, async (options) => {
    requests.push({ ...options, messages: [...options.messages!] });
    return result(
      requests.length === 1
        ? '{"same_place":true,"reason":"unclosed'
        : '{"same_place":false,"reason":"Different sites."}',
    );
  });
  assert.equal(answer.samePlace, false);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.maxTokens, 1024);
  assert.equal(requests[1]!.messages![2]!.role, "assistant");
  assert.match(requests[1]!.messages![3]!.content, /failed validation/);
});
test("truncated and empty completions each receive at most one output repair", async () => {
  for (const message of [
    "Completion truncated by max_tokens",
    "Empty final completion",
  ]) {
    let calls = 0;
    const answer = await adjudicateMatch(input, async () => {
      calls++;
      if (calls === 1)
        throw new LlmError(message, false, undefined, undefined, result(""));
      return result(
        '{"same_place":true,"reason":"Same name, address and phone."}',
      );
    });
    assert.equal(calls, 2);
    assert.equal(answer.samePlace, true);
  }
});
test("a second unusable result is quarantinable validation failure with no third call", async () => {
  let calls = 0;
  await assert.rejects(
    adjudicateMatch(input, async () => {
      calls++;
      return result('{"same_place":"true"}');
    }),
    (error) => {
      assert.ok(error instanceof LlmError);
      assert.ok(recordFailure(error));
      return true;
    },
  );
  assert.equal(calls, 2);
});
test("authentication, unsupported schemas, transport and database failures are not output repairs", async () => {
  for (const error of [
    new LlmError("Unauthorized", false, 401),
    new LlmError("json_schema unsupported", false, 400),
    new LlmError("network", true),
    new Error("database fault"),
  ]) {
    let calls = 0;
    await assert.rejects(
      adjudicateMatch(input, async () => {
        calls++;
        throw error;
      }),
      (e) => e === error,
    );
    assert.equal(calls, 1);
  }
});
test("decision validation rejects prose, containers, missing fields and unsafe implicit booleans", () => {
  for (const text of [
    "true",
    "null",
    "[]",
    '{"same_place":"false","reason":"X"}',
    '{"same_place":true}',
    '{"same_place":true,"reason":""}',
    '{"same_place":true,"reason":"X","extra":1}',
  ])
    assert.throws(() => parseMatchDecision(text));
  assert.equal(
    parseMatchDecision(
      '{"same_place":false,"reason":"A literal } in the explanation."}',
    ).samePlace,
    false,
  );
});
