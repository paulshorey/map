import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Semaphore,
  ProviderLimiter,
  configureLlmConcurrency,
} from "./concurrency.js";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
test("four provider slots exceed threefold serial throughput and preserve FIFO admission", async () => {
  async function measure(n: number) {
    const s = new Semaphore(n);
    let active = 0,
      max = 0;
    const order: number[] = [];
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 16 }, (_, i) =>
        s.run(async () => {
          order.push(i);
          max = Math.max(max, ++active);
          await sleep(25);
          active--;
        }),
      ),
    );
    return { elapsed: performance.now() - start, max, order };
  }
  const serial = await measure(1),
    parallel = await measure(4);
  assert.equal(parallel.max, 4);
  assert.deepEqual(
    parallel.order,
    Array.from({ length: 16 }, (_, i) => i),
  );
  assert.ok(serial.elapsed / parallel.elapsed >= 3);
});
test("throttling halves admission, honors Retry-After, and gradually restores target", async () => {
  let now = 0;
  const limiter = new ProviderLimiter(4, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  limiter.observe(new Headers({ "retry-after": "60" }), 429, 100, 100, 60000);
  assert.equal(limiter.snapshot().effective, 2);
  await limiter.run(async () => undefined);
  assert.ok(now >= 60000);
  now += 900000;
  limiter.observe(new Headers(), 200, 100, 100);
  assert.equal(limiter.snapshot().effective, 3);
  const quota = new Headers({ "x-ratelimit-limit-tokens-generated": "6000" });
  limiter.observe(quota, 200, 100, 1000);
  assert.ok(limiter.snapshot().spacing_ms >= 12500);
});
test("queued admission notices operator stop and concurrency values are bounded", async () => {
  const l = new ProviderLimiter(1);
  l.observe(new Headers(), 429, 1, 1, 60000);
  await assert.rejects(
    l.run(
      async () => {},
      () => true,
    ),
    /admission stopped/,
  );
  for (const n of [0, 17, 1.5, NaN])
    assert.throws(() => configureLlmConcurrency(n), /integer/);
  configureLlmConcurrency(4);
});
