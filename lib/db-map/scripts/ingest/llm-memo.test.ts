import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LlmDeferred,
  MAX_LLM_DEFERRALS,
  memoizedLlm,
  withLlmMemo,
  withLlmOutsideLock,
} from "./llm-memo.js";

test("without a memo a model call is made directly", async () => {
  let calls = 0;
  assert.equal(await memoizedLlm("match", { a: 1 }, async () => ++calls), 1);
  assert.equal(await memoizedLlm("match", { a: 1 }, async () => ++calls), 2);
});

test("an answer is reused only for the identical request and purpose", async () => {
  const memo = new Map<string, unknown>();
  let calls = 0;
  const ask = (purpose: string, request: unknown) =>
    withLlmMemo(memo, false, () =>
      memoizedLlm(purpose, request, async () => `answer ${++calls}`),
    );
  assert.equal(await ask("match", { name: "A", city: "X" }), "answer 1");
  // Key order does not matter; any changed value or purpose does.
  assert.equal(await ask("match", { city: "X", name: "A" }), "answer 1");
  assert.equal(await ask("match", { name: "A", city: "Y" }), "answer 2");
  assert.equal(await ask("description_fusion", { name: "A", city: "X" }), "answer 3");
  assert.equal(calls, 3);
});

test("dates are part of the request: a changed date is a different question", async () => {
  const memo = new Map<string, unknown>();
  let calls = 0;
  const ask = (starts_at: Date | null) =>
    withLlmMemo(memo, false, () =>
      memoizedLlm("match", { candidate: { name: "Fair", starts_at } }, async () => ++calls),
    );
  assert.equal(await ask(new Date("2027-05-01T00:00:00Z")), 1);
  assert.equal(await ask(new Date("2027-05-01T00:00:00Z")), 1);
  assert.equal(await ask(new Date("2028-05-01T00:00:00Z")), 2);
  assert.equal(await ask(null), 3);
});

test("deferred mode never calls inside the locked work; the call runs after it unwinds", async () => {
  let locked = false,
    passes = 0;
  const calledWhileLocked: boolean[] = [];
  const result = await withLlmOutsideLock(async () => {
    locked = true;
    passes++;
    try {
      const first = await memoizedLlm("match", "pair", async () => {
        calledWhileLocked.push(locked);
        return "same";
      });
      const second = await memoizedLlm("description_fusion", [first], async () => {
        calledWhileLocked.push(locked);
        return "fused";
      });
      return `${first}/${second}`;
    } finally {
      locked = false; // the lock and transaction end when the work unwinds
    }
  });
  assert.equal(result, "same/fused");
  assert.deepEqual(calledWhileLocked, [false, false]);
  assert.equal(passes, 3, "one pass per missing answer, then the pass that completes");
});

test("a prefilled memo completes in one pass", async () => {
  const memo = new Map<string, unknown>();
  await withLlmMemo(memo, false, () => memoizedLlm("match", "pair", async () => "same"));
  let passes = 0;
  const result = await withLlmOutsideLock(async () => {
    passes++;
    return memoizedLlm("match", "pair", async () => {
      throw new Error("the answer is already known");
    });
  }, memo);
  assert.equal(result, "same");
  assert.equal(passes, 1);
});

test("after the deferral limit the remaining calls are made in place, so work always finishes", async () => {
  let passes = 0,
    inPlace = 0;
  const result = await withLlmOutsideLock(async () => {
    passes++;
    // The request changes on every pass, as it would if the data kept changing.
    return memoizedLlm("match", { pass: passes }, async () => {
      if (passes > MAX_LLM_DEFERRALS) inPlace++;
      return `answer for pass ${passes}`;
    });
  });
  assert.equal(passes, MAX_LLM_DEFERRALS + 1);
  assert.equal(inPlace, 1);
  assert.equal(result, `answer for pass ${MAX_LLM_DEFERRALS + 1}`);
});

test("other failures pass through untouched, and a failed model call is not remembered", async () => {
  await assert.rejects(
    withLlmOutsideLock(async () => {
      throw new Error("database failure");
    }),
    /database failure/,
  );
  let attempts = 0;
  await assert.rejects(
    withLlmOutsideLock(() =>
      memoizedLlm("match", "pair", async () => {
        attempts++;
        throw new Error("provider failure");
      }),
    ),
    /provider failure/,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    withLlmMemo(new Map(), true, () => memoizedLlm("match", "pair", async () => "x")),
    LlmDeferred,
  );
});
