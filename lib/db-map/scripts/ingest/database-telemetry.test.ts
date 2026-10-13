import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Pool } from "pg";
import {
  measureDatabase,
  labelDatabaseConnection,
} from "./database-telemetry.js";
import {
  withAttemptContext,
  currentAttempt,
  errorDetails,
} from "./execution.js";
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

class FixtureClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(callback: (error?: Error) => void) {
    queueMicrotask(() => callback());
  }
  end() {
    this._ending = true;
    this.emit("end");
  }
  ref() {}
  unref() {}
}

test("real pg-pool checkout saturation records holders without replaying a query", async () => {
  // The real pool owns queueing/timeouts; fixture clients never open a network connection.
  const db = new Pool({
    Client: FixtureClient,
    max: 2,
    connectionTimeoutMillis: 20,
    idleTimeoutMillis: 0,
  } as any);
  measureDatabase(db);
  const source = await db.connect();
  labelDatabaseConnection(db, source, "source_lock");
  const ctx = {
    stage: "match",
    attemptId: "fixture",
    runId: "fixture",
    claim: { source_record_id: "20908" },
  } as NonNullable<ReturnType<typeof currentAttempt>>;
  const match = await withAttemptContext(ctx, () => db.connect());
  try {
    await assert.rejects(
      db.query("SELECT secret_parameter_should_not_be_retained"),
      (error: any) => {
        const details = errorDetails(error) as any;
        assert.equal(details.code, "database_pool_checkout_timeout");
        assert.equal(details.database.operation, "checkout");
        assert.equal(details.database.pool.total, 2);
        assert.equal(details.database.pool.idle, 0);
        assert.equal(details.database.pool.holders.length, 2);
        assert.ok(
          details.database.pool.holders.some(
            (h: any) => h.role === "source_lock",
          ),
        );
        assert.ok(
          details.database.pool.holders.some(
            (h: any) => h.stage === "match" && h.source_record_id === "20908",
          ),
        );
        assert.ok(
          !JSON.stringify(details.database).includes("secret_parameter"),
        );
        return true;
      },
    );
    const callbackError: any = await new Promise((resolve) =>
      db.connect((error) => resolve(error)),
    );
    assert.equal(callbackError.code, "database_pool_checkout_timeout");
    match.release();
    source.release();
    const next = await db.connect();
    next.release();
    assert.equal(db.waitingCount, 0);
    assert.equal(db.idleCount, 2);
  } finally {
    // release is already tested above; destroy remaining fixture clients if an assertion failed.
    if (db.idleCount < 2) {
      try {
        match.release(true);
      } catch {}
      try {
        source.release(true);
      } catch {}
    }
    await db.end();
  }
});
