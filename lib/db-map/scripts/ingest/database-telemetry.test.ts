import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type Socket } from "node:net";
import { Pool } from "pg";
import {
  measureDatabase,
  labelDatabaseConnection,
  withDatabaseOperation,
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
  end(callback?: () => void) {
    this._ending = true;
    this.emit("end");
    callback?.();
  }
  queryCalls = 0;
  query(text: any, values: any, callback: any) {
    this.queryCalls++;
    const cb = typeof values === "function" ? values : callback;
    queueMicrotask(() =>
      cb(
        text === "fail"
          ? Object.assign(new Error("query failed"), { code: "XX000" })
          : null,
        { rows: [] },
      ),
    );
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
        assert.equal(details.database.acquisition.timeout_kind, "pool_wait");
        assert.equal(details.database.acquisition.before.total, 2);
        assert.ok(details.database.acquisition.elapsed_ms >= 15);
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

test("real pg connection establishment stalls differ from waiting for a pool slot, for both APIs", async () => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const db = new Pool({
    host: "127.0.0.1",
    port: (server.address() as any).port,
    user: "fixture",
    database: "fixture",
    connectionTimeoutMillis: 50,
    max: 2,
  });
  measureDatabase(db);
  try {
    for (const callback of [false, true]) {
      const acquire = () =>
        callback
          ? new Promise((resolve, reject) =>
              db.connect((error, client, release) => {
                if (error) reject(error);
                else {
                  release();
                  resolve(client);
                }
              }),
            )
          : db.connect();
      await assert.rejects(
        withDatabaseOperation("provider_preflight_call", acquire),
        (error: any) => {
          const detail = errorDetails(error);
          assert.equal(detail.code, "database_connection_timeout");
          assert.equal(
            (detail.database as any).acquisition.timeout_kind,
            "connection_establishment",
          );
          assert.equal((detail.database as any).acquisition.before.total, 0);
          assert.equal(
            (detail.database as any).label,
            "provider_preflight_call",
          );
          assert.ok(
            (detail.database as any).acquisition.origin.includes(
              "database-telemetry.test",
            ),
          );
          assert.equal((detail.database as any).pool.holders.length, 0);
          assert.ok(error.cause instanceof Error);
          assert.equal(detail.cause?.name, error.cause.name);
          return true;
        },
      );
      assert.equal(db.totalCount, 0);
      assert.equal(db.waitingCount, 0);
    }
  } finally {
    await db.end();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("connection rejection preserves error identity/code/cause and never submits a query", async () => {
  const cause = Object.assign(new Error("fixture root"), {
    code: "ECONNRESET",
  });
  const failure: any = Object.assign(
    new Error("fixture rejection", { cause }),
    {
      code: "28P01",
    },
  );
  class RejectClient extends FixtureClient {
    override connect(callback: (error?: Error) => void) {
      queueMicrotask(() => callback(failure));
    }
  }
  const db = new Pool({
    Client: RejectClient,
    connectionTimeoutMillis: 50,
  } as any);
  measureDatabase(db);
  try {
    await assert.rejects(
      db.query("secret_sql", ["secret_parameter"]),
      (error: any) => {
        assert.equal(error, failure);
        assert.equal(error.code, "28P01");
        assert.equal(error.cause, cause);
        assert.equal(errorDetails(error).cause?.code, "ECONNRESET");
        assert.ok(!JSON.stringify(error.database).includes("secret_"));
        return true;
      },
    );
    assert.equal(db.totalCount, 0);
    assert.equal(db.waitingCount, 0);
  } finally {
    await db.end();
  }
});

test("idle errors, destroyed releases and failed queries remove clients without replay or stale holders", async () => {
  const db = new Pool({
    Client: FixtureClient,
    max: 1,
    idleTimeoutMillis: 0,
  } as any);
  measureDatabase(db);
  try {
    const first = await db.connect();
    first.release();
    first.emit(
      "error",
      Object.assign(new Error("fixture idle disconnect"), {
        code: "ECONNRESET",
      }),
    );
    assert.equal(db.totalCount, 0);
    const second = await db.connect();
    assert.notEqual(first, second);
    second.release(true);
    assert.throws(() => second.release(), /already been released/);
    const third = await db.connect();
    third.release();
    await assert.rejects(db.query("fail"), (error: any) => {
      assert.equal(error.code, "XX000");
      assert.equal(error.database.operation, "query");
      // The client query callback observes its lease before pool.query releases it.
      assert.equal(error.database.pool.holders.length, 1);
      assert.equal(error.database.pool.holders[0].role, "pool_query");
      assert.ok(
        error.database.recent_events.some((e: any) => e.event === "idle_error"),
      );
      return true;
    });
    assert.equal((third as any).queryCalls, 1);
    assert.equal(db.totalCount, 0);
    await new Promise<void>((resolve, reject) =>
      db.query("healthy callback", (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    assert.equal(db.waitingCount, 0);
    assert.equal(db.idleCount, 1);
    for (let i = 0; i < 30; i++) await db.query("healthy");
    await assert.rejects(db.query("fail"), (error: any) => {
      assert.equal(error.database.recent_events.length, 64);
      return true;
    });
  } finally {
    await db.end();
  }
});

test("submittable query objects retain identity, prototype, callback and return value", () => {
  class Submittable {
    callback() {}
    submit() {}
  }
  const input = new Submittable(),
    callback = input.callback;
  const db = Object.assign(new EventEmitter(), {
    query(q: Submittable) {
      assert.equal(q, input);
      return q;
    },
  });
  measureDatabase(db as unknown as Pool);
  assert.equal(db.query(input), input);
  assert.equal(input.callback, callback);
});
