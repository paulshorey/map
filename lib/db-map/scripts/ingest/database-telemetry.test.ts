import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { measureDatabase } from "./database-telemetry.js";
import { withAttemptContext, currentAttempt } from "./execution.js";
test("database timing handles pg callbacks and promises without double counting", async () => {
  const client = {
    query: (...args: any[]) => {
      if (args[0] === "throw") throw new Error("query failure");
      if (typeof args.at(-1) === "function") {
        setTimeout(() => args.at(-1)(null, { rows: [] }), 5);
        return;
      }
      return new Promise((r) => setTimeout(() => r({ rows: [] }), 5));
    },
  };
  const pool = Object.assign(new EventEmitter(), {
    query: (...args: any[]) =>
      new Promise((resolve, reject) => {
        client.query(...args, (error: unknown, value: unknown) =>
          error ? reject(error) : resolve(value),
        );
      }),
  });
  measureDatabase(pool as unknown as Pool);
  pool.emit("acquire", client);
  const ctx = {
    stage: "test",
    attemptId: "test",
    runId: "test",
  } as NonNullable<ReturnType<typeof currentAttempt>>;
  await withAttemptContext(ctx, async () => {
    await pool.query("pool promise");
    await client.query("client promise");
    await new Promise((r) => client.query("client callback", r));
    assert.throws(() => client.query("throw"), /query failure/);
  });
  assert.equal(ctx.databaseQueries, 4);
  assert.ok(ctx.databaseMs! >= 10);
});
