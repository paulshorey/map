import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { callNormalizer } from "./runner.js";
import { ingestConfig, readLlmConfig } from "../config.js";

const originalFetch = globalThis.fetch,
  originalConfig = { ...ingestConfig.llm },
  originalKey = process.env.FIREWORKS_API_KEY;
const output = {
  record: {
    record_id: "fixture",
    is_poi: true,
    invalid_reason: null,
    entity_kind: "place",
    display_name: "Camp A",
    series_name: null,
    edition_year: null,
    aliases: [],
    description: null,
    venue: null,
    address: null,
    city: null,
    region: null,
    country_code: "US",
    website_candidate_id: null,
    phone_candidate_id: null,
    email_candidate_id: null,
    starts_at: null,
    ends_at: null,
    date_precision: null,
    attributes: [],
    warnings: [],
    evidence: [],
  },
};
const row = {
  id: "fixture",
  active_observation_id: "observation",
} as Parameters<typeof callNormalizer>[1];
let requests: Record<string, unknown>[],
  queries: { sql: string; args: unknown[] }[];
beforeEach(() => {
  Object.assign(ingestConfig.llm, readLlmConfig({}));
  process.env.FIREWORKS_API_KEY = "fixture";
  requests = [];
  queries = [];
  globalThis.fetch = async () => {
    throw new Error("Unmocked inference is forbidden");
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(ingestConfig.llm, originalConfig);
  if (originalKey === undefined) delete process.env.FIREWORKS_API_KEY;
  else process.env.FIREWORKS_API_KEY = originalKey;
});
const db = {
  query: async (sql: string, args: unknown[]) => {
    queries.push({ sql, args });
    return { rows: [] };
  },
} as unknown as Pool;
function respond(
  firstContent: string,
  firstReason = "stop",
  secondContent = JSON.stringify(output),
) {
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(String(options!.body)));
    return Response.json({
      model: ingestConfig.llm.model,
      choices: [
        {
          message: {
            content: requests.length === 1 ? firstContent : secondContent,
          },
          finish_reason: requests.length === 1 ? firstReason : "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
}
test("normalization repairs malformed JSON once and links separate audit rows", async () => {
  respond('{"record":');
  const answer = await callNormalizer(db, row, "hash", "generic", "v1", {});
  assert.equal(answer.output.record.record_id, "fixture");
  assert.equal(requests.length, 2);
  const inserts = queries.filter((q) =>
    q.sql.includes("INSERT INTO research_normalization_requests"),
  );
  assert.equal(inserts.length, 2);
  assert.equal(inserts[1]!.args[11], inserts[0]!.args[0]);
});
test("normalization retries truncated/empty output once with a bounded larger allowance", async () => {
  for (const [content, finish] of [
    ["{", "length"],
    ["", "stop"],
  ]) {
    requests = [];
    queries = [];
    respond(content!, finish!);
    await callNormalizer(db, row, "hash", "generic", "v1", {});
    assert.equal(requests.length, 2);
    assert.ok(
      Number(requests[1]!.max_tokens) > Number(requests[0]!.max_tokens),
    );
  }
});
test("failed normalization repair cannot trigger a third request", async () => {
  respond('{"record":', "stop", "bad again");
  await assert.rejects(callNormalizer(db, row, "hash", "generic", "v1", {}));
  assert.equal(requests.length, 2);
});
test("normalization repair retains a working JSON-object fallback and remains bounded", async () => {
  for (const [content, finish] of [
    ["{", "length"],
    ["", "stop"],
    ["bad", "stop"],
  ]) {
    for (const repairContent of [JSON.stringify(output), "bad repair"]) {
      requests = [];
      queries = [];
      globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(String(options!.body)));
        if (requests.length === 1)
          return Response.json(
            { error: { message: "json_schema response_format not supported" } },
            { status: 400 },
          );
        return Response.json({
          model: ingestConfig.llm.model,
          choices: [{
            message: { content: requests.length === 2 ? content : repairContent },
            finish_reason: requests.length === 2 ? finish : "stop",
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
      };
      const answer = callNormalizer(db, row, "hash", "generic", "v1", {});
      if (repairContent === "bad repair") await assert.rejects(answer);
      else assert.equal((await answer).output.record.record_id, "fixture");
      assert.equal(requests.length, 3, "one capability fallback plus one output repair");
      assert.deepEqual(
        requests.slice(1).map((request) => request.response_format),
        [{ type: "json_object" }, { type: "json_object" }],
      );
      const inserts = queries.filter((q) =>
        q.sql.includes("INSERT INTO research_normalization_requests"),
      );
      assert.equal(inserts.length, 3);
      assert.equal(inserts[2]!.args[11], inserts[1]!.args[0]);
      assert.deepEqual(JSON.parse(String(inserts[2]!.args[10])).response_format, {
        type: "json_object",
      });
    }
  }
});
test("normalization does not spend another request on authentication or database audit failures", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      { error: { message: "Unauthorized" } },
      { status: 401 },
    );
  };
  await assert.rejects(
    callNormalizer(db, row, "hash", "generic", "v1", {}),
    /Unauthorized/,
  );
  assert.equal(calls, 1);
  respond(JSON.stringify(output));
  const broken = {
    query: async (sql: string, args: unknown[]) => {
      if (sql.includes("UPDATE research_normalization_requests"))
        throw new Error("audit database failed");
      return db.query(sql, args);
    },
  } as unknown as Pool;
  await assert.rejects(
    callNormalizer(broken, row, "hash", "generic", "v1", {}),
    /audit database failed/,
  );
  assert.equal(requests.length, 1);
});
