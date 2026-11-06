import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { geocode, reverseGeocode } from "./locationiq.js";
import {
  ProviderQuotaExhausted,
  dailyLimit,
  nextUtcMidnight,
  reserveProviderRequest,
  resetProviderQuotaState,
  useProviderQuotaLedger,
} from "./quota.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.LOCATIONIQ_API_KEY;
const originalLimit = process.env.LOCATIONIQ_DAILY_LIMIT;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetProviderQuotaState();
  if (originalKey === undefined) delete process.env.LOCATIONIQ_API_KEY;
  else process.env.LOCATIONIQ_API_KEY = originalKey;
  if (originalLimit === undefined) delete process.env.LOCATIONIQ_DAILY_LIMIT;
  else process.env.LOCATIONIQ_DAILY_LIMIT = originalLimit;
});

/** In-memory stand-in for research_provider_daily_usage. */
function ledger(requests = 0) {
  const state = { requests, rateLimitedAt: null as string | null, sql: [] as string[] };
  return {
    state,
    async query(sql: string, args: unknown[] = []) {
      state.sql.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("SET requests = u.requests + 1")) {
        const limit = args[1] as number | null;
        if (state.rateLimitedAt || (limit !== null && state.requests >= limit)) return { rows: [] };
        state.requests++;
        return { rows: [{ day: "2026-11-06", requests: state.requests }] };
      }
      if (sql.includes("GREATEST(requests - 1, 0)")) {
        state.requests = Math.max(0, state.requests - 1);
        return { rows: [] };
      }
      if (sql.includes("rate_limited_at = COALESCE")) {
        state.rateLimitedAt ??= new Date().toISOString();
        return { rows: [{ requests: state.requests }] };
      }
      if (sql.startsWith("SELECT requests, rate_limited_at"))
        return { rows: [{ requests: state.requests, rate_limited_at: state.rateLimitedAt }] };
      throw new Error(`Unexpected ledger SQL: ${sql}`);
    },
  };
}

test("the daily limit defaults to the free plan and 0 disables it", () => {
  delete process.env.LOCATIONIQ_DAILY_LIMIT;
  assert.equal(dailyLimit("locationiq"), 5000);
  process.env.LOCATIONIQ_DAILY_LIMIT = "0";
  assert.equal(dailyLimit("locationiq"), null);
  process.env.LOCATIONIQ_DAILY_LIMIT = "25000";
  assert.equal(dailyLimit("locationiq"), 25000);
  assert.equal(dailyLimit("jina"), null);
  assert.equal(nextUtcMidnight(new Date("2026-11-05T23:59:00Z")).toISOString(), "2026-11-06T00:00:00.000Z");
});

test("the local limit refuses a request before it is sent", async () => {
  process.env.LOCATIONIQ_API_KEY = "fixture";
  process.env.LOCATIONIQ_DAILY_LIMIT = "2";
  const db = ledger(1);
  useProviderQuotaLedger(db as never);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json([]);
  };
  assert.equal(await geocode("Austin, Texas", "US"), null);
  assert.equal(db.state.requests, 2);
  await assert.rejects(geocode("Dallas, Texas", "US"), (error: unknown) => {
    assert.ok(error instanceof ProviderQuotaExhausted);
    assert.equal(error.reason, "local_daily_limit");
    assert.equal(error.used, 2);
    return true;
  });
  assert.equal(calls, 1, "the refused lookup never reached the provider");
});

test("'Rate Limited Day' stops all later lookups without retrying; per-second limits stay retryable", async () => {
  process.env.LOCATIONIQ_API_KEY = "fixture";
  const db = ledger(10);
  useProviderQuotaLedger(db as never);
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: calls === 1 ? "Rate Limited Second" : "Rate Limited Day" }), {
      status: 429,
    });
  };
  await assert.rejects(geocode("Austin, Texas", "US"), (error: any) => {
    assert.ok(!(error instanceof ProviderQuotaExhausted));
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(db.state.requests, 10, "an uncharged per-second 429 is released");
  await assert.rejects(reverseGeocode(30, -97), (error: unknown) => {
    assert.ok(error instanceof ProviderQuotaExhausted);
    assert.equal(error.reason, "provider_rate_limited_day");
    return true;
  });
  assert.ok(db.state.rateLimitedAt);
  await assert.rejects(geocode("Dallas, Texas", "US"), ProviderQuotaExhausted);
  assert.equal(calls, 2);
});

test("without a ledger the in-process 'Rate Limited Day' flag still holds", async () => {
  process.env.LOCATIONIQ_API_KEY = "fixture";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ error: "Rate Limited Day" }), { status: 429 });
  };
  await assert.rejects(geocode("Austin, Texas", "US"), ProviderQuotaExhausted);
  await assert.rejects(reserveProviderRequest("locationiq"), ProviderQuotaExhausted);
  assert.equal(calls, 1);
});

test("an invalid-query 400 is not charged and releases its reservation", async () => {
  process.env.LOCATIONIQ_API_KEY = "fixture";
  const db = ledger(3);
  useProviderQuotaLedger(db as never);
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: "Invalid Request" }), { status: 400 });
  await assert.rejects(geocode("x".repeat(10), "US"), (error: any) => error.status === 400);
  assert.equal(db.state.requests, 3);
});

test("a 404 miss is not charged and releases its reservation", async () => {
  process.env.LOCATIONIQ_API_KEY = "fixture";
  const db = ledger(7);
  useProviderQuotaLedger(db as never);
  globalThis.fetch = async () => Response.json({ error: "Unable to geocode" }, { status: 404 });
  assert.equal(await geocode("Nowhere", "US"), null);
  assert.equal(await reverseGeocode(30, -97), null);
  assert.equal(db.state.requests, 7);
});
