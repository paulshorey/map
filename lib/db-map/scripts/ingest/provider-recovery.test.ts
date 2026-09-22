import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { Execution } from "./execution.js";
import {
  ProviderRecovery,
  ProviderRecoveryExhausted,
  type RecoveryEvent,
} from "./provider-recovery.js";
import { completeChat, LlmError, retryAfterMs } from "./providers/llm.js";

function fixture() {
  let now = 0;
  let stopped = false;
  let onSleep = () => {};
  const events: RecoveryEvent[] = [];
  const recovery = new ProviderRecovery({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      onSleep();
    },
    random: () => 0,
  });
  return {
    recovery,
    events,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    stop: () => {
      stopped = true;
    },
    onSleep: (fn: () => void) => {
      onSleep = fn;
    },
    run: (attempt: () => Promise<string>) =>
      recovery.run({
        attempt,
        stopped: () => stopped,
        paused: () => "paused",
        event: async (e) => {
          events.push(e);
        },
      }),
  };
}

test("429 then 503 recover with 30/60 second cooldowns", async () => {
  const f = fixture();
  let calls = 0;
  assert.equal(
    await f.run(async () => {
      if (++calls < 3)
        throw new LlmError("busy", true, calls === 1 ? 429 : 503);
      return "done";
    }),
    "done",
  );
  assert.equal(calls, 3);
  assert.equal(f.now(), 90_000);
  assert.deepEqual(
    f.events.map((e) => e.state),
    ["cooldown", "cooldown", "recovered"],
  );
});

test("persistent outage exhausts five retries and retains provider cause", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    f.run(async () => {
      calls++;
      throw new LlmError("busy", true, 429);
    }),
    (e: unknown) =>
      e instanceof ProviderRecoveryExhausted &&
      e.reason === "record_retry_limit" &&
      e.providerError.status === 429,
  );
  assert.equal(calls, 6);
  assert.equal(f.now(), 750_000);
});

test("Retry-After is a minimum; excessive cooldown stops without an early retry", async () => {
  const f = fixture();
  let calls = 0;
  await f.run(async () => {
    if (++calls === 1) throw new LlmError("busy", true, 429, 120_000);
    return "ok";
  });
  assert.equal(f.now(), 120_000);
  const long = fixture();
  await assert.rejects(
    long.run(async () => {
      throw new LlmError("busy", true, 429, 1_000_000);
    }),
    /record_deadline/,
  );
  assert.equal(long.now(), 0);
});

test("time spent making requests and overslept timers count toward deadline", async () => {
  const f = fixture();
  let calls = 0;
  await assert.rejects(
    f.run(async () => {
      calls++;
      f.advance(880_000);
      throw new LlmError("busy", true, 503);
    }),
    /record_deadline/,
  );
  assert.equal(calls, 1);
  const oversleep = fixture();
  oversleep.onSleep(() => oversleep.advance(900_000));
  calls = 0;
  await assert.rejects(
    oversleep.run(async () => {
      calls++;
      throw new LlmError("busy", true, 429);
    }),
    /record_deadline/,
  );
  assert.equal(calls, 1);
});

test("pause during cooldown stops promptly without another provider call", async () => {
  const f = fixture();
  f.onSleep(f.stop);
  let calls = 0;
  assert.equal(
    await f.run(async () => {
      calls++;
      throw new LlmError("busy", true, 429);
    }),
    "paused",
  );
  assert.equal(calls, 1);
  assert.equal(f.now(), 1_000);
  assert.equal(f.events.at(-1)?.state, "paused");
});

test("authentication, validation, empty output and database errors do not enter recovery", async () => {
  for (const error of [
    new LlmError("unauthorized", false, 401),
    new LlmError("bad input", false, 400),
    new LlmError("Empty completion", true),
    new Error("validation"),
    new Error("database unavailable"),
  ]) {
    const f = fixture();
    await assert.rejects(
      f.run(async () => {
        throw error;
      }),
      (e) => e === error,
    );
    assert.equal(f.events.length, 0);
  }
});

test("execution retry cap spans records", async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    let calls = 0;
    await f.run(async () => {
      if (++calls === 1) throw new LlmError("busy", true, 429);
      return "ok";
    });
  }
  await assert.rejects(
    f.run(async () => {
      throw new LlmError("busy", true, 429);
    }),
    /execution_retry_limit/,
  );
});

test("heartbeat/database failure during cooldown aborts recovery without a new attempt", async () => {
  let checks = 0;
  let calls = 0;
  const failure = new Error("heartbeat failed");
  const f = fixture();
  await assert.rejects(
    f.recovery.run({
      attempt: async () => {
        calls++;
        throw new LlmError("busy", true, 429);
      },
      stopped: () => {
        if (++checks >= 3) throw failure;
        return false;
      },
      paused: () => "paused",
      event: async () => {},
    }),
    (error) => error === failure,
  );
  assert.equal(calls, 1);
});

test("managed retries append attempts, preserve errors, and recheck budget before another request", async () => {
  const f = fixture();
  const attempts: Array<{ status: string; error?: Record<string, unknown> }> =
    [];
  const counters: RecoveryEvent[] = [];
  const db = {
    query: async (sql: string, params: unknown[]) => {
      if (sql.includes("INSERT INTO research_ingest_attempts")) {
        attempts.push({ status: "running" });
        return { rows: [{ id: String(attempts.length - 1) }] };
      }
      if (sql.includes("SET status='failed'")) {
        attempts[Number(params[0])] = {
          status: "failed",
          error: JSON.parse(String(params[1])),
        };
      } else if (sql.includes("SET status=$2,output"))
        attempts[Number(params[0])]!.status = String(params[1]);
      else if (sql.includes("providerRecovery"))
        counters.push(JSON.parse(String(params[1])));
      return { rows: [] };
    },
  } as unknown as Pool;
  const ex = new Execution(
    db,
    randomUUID(),
    randomUUID(),
    {} as PoolClient,
    f.recovery,
  );
  let providerCalls = 0;
  const result = await ex.attempt("normalize", "16930", {}, async () => {
    if (providerCalls >= 1) return { status: "waiting_budget" };
    providerCalls++;
    throw new LlmError("busy", true, 429, 45_000);
  });
  assert.equal(result.status, "waiting_budget");
  assert.equal(providerCalls, 1);
  assert.deepEqual(
    attempts.map((a) => a.status),
    ["failed", "waiting_budget"],
  );
  assert.equal(attempts[0]!.error?.status, 429);
  assert.equal(attempts[0]!.error?.retryAfterMs, 45_000);
  assert.equal(counters.at(-1)?.state, "settled");
  // Resume/retry with a replenished test allowance; successful checkpoints are not called again.
  const success = async () => {
    providerCalls++;
    return { status: "succeeded" as const, artifactId: "retained" };
  };
  assert.equal(
    (await ex.attempt("normalize", "16930", {}, success)).artifactId,
    "retained",
  );
  assert.equal(
    (await ex.attempt("normalize", "16930", {}, success)).artifactId,
    "retained",
  );
  assert.equal(providerCalls, 2);
  assert.equal(attempts.length, 3);
});

test("Retry-After parses seconds/date and rejects invalid values", () => {
  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs(null), undefined);
  assert.equal(retryAfterMs("nonsense"), undefined);
  assert.equal(retryAfterMs("-1"), undefined);
  assert.equal(retryAfterMs(new Date(Date.now() - 1000).toUTCString()), 0);
});

test("HTML 429 retains status and cooldown without hidden managed transport retries", async () => {
  const original = globalThis.fetch;
  const oldKey = process.env.FIREWORKS_API_KEY;
  process.env.FIREWORKS_API_KEY = "fixture";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("busy", {
      status: 429,
      headers: { "retry-after": "120" },
    });
  };
  try {
    await assert.rejects(
      completeChat({ system: "fixture", user: "fixture", retries: 0 }),
      (e: unknown) =>
        e instanceof LlmError &&
        e.status === 429 &&
        e.retryable &&
        e.retryAfterMs === 120_000,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    if (oldKey === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = oldKey;
  }
});

test("completeChat posts to Fireworks with thinking disabled", async () => {
  const original = globalThis.fetch;
  const oldKey = process.env.FIREWORKS_API_KEY;
  process.env.FIREWORKS_API_KEY = "fixture";
  let request: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { url: String(input), init: init ?? {} };
    return Response.json({
      model: "accounts/fireworks/models/deepseek-v4p1-flash",
      choices: [
        { message: { content: '{"ok":true}' }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    });
  };
  try {
    const result = await completeChat({
      system: "fixture",
      user: "fixture",
      retries: 0,
    });
    assert.ok(request);
    assert.equal(
      request.url,
      "https://api.fireworks.ai/inference/v1/chat/completions",
    );
    const body = JSON.parse(String(request.init.body));
    assert.equal(
      body.model,
      "accounts/fireworks/models/deepseek-v4p1-flash",
    );
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(
      (request.init.headers as Record<string, string>).Authorization,
      "Bearer fixture",
    );
    assert.equal(result.content, '{"ok":true}');
    assert.equal(result.usage.cachedTokens, 10);
    assert.equal(result.usage.estimatedCost, (90 * 0.22 + 10 * 0.007 + 20 * 0.66) / 1_000_000);
  } finally {
    globalThis.fetch = original;
    if (oldKey === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = oldKey;
  }
});
