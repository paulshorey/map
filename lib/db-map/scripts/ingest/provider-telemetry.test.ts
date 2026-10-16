import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { reverseGeocode, geocode } from "./providers/locationiq.js";
import { withAttemptContext, errorDetails } from "./execution.js";
import { isTransientProviderError } from "./provider-recovery.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.LOCATIONIQ_API_KEY;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.LOCATIONIQ_API_KEY;
  else process.env.LOCATIONIQ_API_KEY = originalKey;
});
function fixture(failAt = 0) {
  process.env.LOCATIONIQ_API_KEY = "fixture-only";
  const failure: any = Object.assign(new Error("fixture database failure"), {
    code: "database_pool_checkout_timeout",
  });
  const writes: any[] = [],
    lifecycle: any[] = [];
  const ctx = {
    runId: "run",
    attemptId: "attempt",
    stage: "geocode",
    execution: {
      id: "ex",
      stopped: false,
      abortController: new AbortController(),
      recordProviderLifecycle: (event: any) => lifecycle.push(event),
      db: {
        query: async (sql: string, args: any[]) => {
          writes.push({ sql, args });
          if (writes.length === failAt) throw failure;
          return { rows: [] };
        },
      },
    },
  } as any;
  return { ctx, failure, writes, lifecycle };
}
const response = () =>
  Response.json({
    lat: "25.0731",
    lon: "121.526",
    address: { country_code: "tw", city: "Taipei" },
  });

test("preflight failures in either database write stop before fetch and preserve the failing phase", async () => {
  for (const failAt of [1, 2]) {
    const f = fixture(failAt);
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return response();
    };
    await assert.rejects(
      withAttemptContext(f.ctx, () => reverseGeocode(25.0731, 121.526)),
      (error: any) => {
        assert.equal(error, f.failure);
        assert.equal(isTransientProviderError(error), false);
        assert.equal(
          errorDetails(error).provider_call &&
            (errorDetails(error).provider_call as any).phase,
          "preflight_failed",
        );
        assert.equal(error.provider_call.request_started, false);
        return true;
      },
    );
    assert.equal(requests, 0);
    assert.equal(f.writes.length, failAt);
    assert.equal(f.lifecycle.at(-1).phase, "preflight_failed");
  }
});

test("HTTP success followed by bookkeeping failure retains HTTP evidence and attempts one terminal write", async () => {
  const f = fixture(3);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response();
  };
  await assert.rejects(
    withAttemptContext(f.ctx, () => reverseGeocode(25.0731, 121.526)),
    (error: any) => {
      assert.equal(error, f.failure);
      assert.equal(error.provider_call.phase, "result_recording_failed");
      assert.equal(error.provider_call.request_started, true);
      assert.equal(error.provider_call.http_status, 200);
      return true;
    },
  );
  assert.equal(requests, 1);
  assert.equal(f.writes.length, 3);
  assert.equal(
    f.lifecycle.filter((e) => e.phase === "result_recording").length,
    1,
  );
  assert.equal(f.lifecycle.at(-1).phase, "result_recording_failed");
  assert.ok(!JSON.stringify(f.lifecycle).includes("fixture-only"));
  assert.ok(!JSON.stringify(f.lifecycle).includes("https://"));
});

test("provider error plus terminal DB failure retains both errors without repeating either operation", async () => {
  const f = fixture(3);
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response("unavailable", { status: 503 });
  };
  await assert.rejects(
    withAttemptContext(f.ctx, () => reverseGeocode(25.0731, 121.526)),
    (error: any) => {
      assert.equal(error, f.failure);
      assert.equal(error.provider_error.status, 503);
      assert.equal(error.provider_call.http_status, 503);
      assert.equal(isTransientProviderError(error), false);
      return true;
    },
  );
  assert.equal(requests, 1);
  assert.equal(f.writes.length, 3);
});

test("database cancellation during forward/reverse HTTP preserves the scheduler error and never becomes a geocoder miss", async () => {
  for (const lookup of [
    () => reverseGeocode(25.0731, 121.526),
    () => geocode("fixture query"),
  ]) {
    const f = fixture();
    let requests = 0;
    globalThis.fetch = async (_url, init) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(init!.signal!.reason),
          { once: true },
        );
        queueMicrotask(() => f.ctx.execution.abortController.abort(f.failure));
      });
    };
    await assert.rejects(
      withAttemptContext<unknown>(f.ctx, lookup),
      (error) => error === f.failure,
    );
    assert.equal(requests, 1);
    assert.equal(f.writes.length, 3);
    assert.equal(f.writes[2].args[1], "failed");
    assert.equal(f.writes[2].args[9], null);
    assert.equal(
      JSON.parse(f.writes[2].args[12]).code,
      "database_pool_checkout_timeout",
    );
    assert.equal(f.lifecycle.at(-1).outcome, "failed");
  }
});

test("a definitive 404 records an HTTP miss distinctly from cancellation or database failure", async () => {
  const f = fixture();
  globalThis.fetch = async () => new Response(null, { status: 404 });
  assert.equal(
    await withAttemptContext(f.ctx, () => reverseGeocode(25.0731, 121.526)),
    null,
  );
  assert.equal(f.writes[2].args[1], "succeeded");
  assert.equal(f.writes[2].args[9], 404);
  assert.equal(
    f.lifecycle.find((e) => e.phase === "response_received").http_status,
    404,
  );
});
