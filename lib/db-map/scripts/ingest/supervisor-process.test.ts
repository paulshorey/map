import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { superviseProcess, type ProcessOptions } from "./supervisor-process.js";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function run(extra: Partial<ProcessOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "sup-"));
  try {
    return await superviseProcess({
      command: process.execPath,
      args: ["-e", "setTimeout(()=>{},30)"],
      cwd: dir,
      log: join(dir, "log"),
      timeoutMs: 3000,
      graceMs: 100,
      healthIntervalMs: 3600_000,
      health: async () => undefined,
      onStart: async () => {},
      onMessage: async () => {},
      registerStop: () => () => {},
      ...extra,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
test("success/failure and no early hourly health check", async () => {
  let checks = 0;
  assert.equal(
    (
      await run({
        health: async () => {
          checks++;
          return undefined;
        },
      })
    ).code,
    0,
  );
  assert.equal(checks, 0);
  assert.equal((await run({ args: ["-e", "process.exit(3)"] })).code, 3);
});
test("awaits health that is still in flight after child exits", async () => {
  let release!: () => void,
    started!: () => void,
    finished = false;
  const active = new Promise<void>((r) => {
      release = r;
    }),
    start = new Promise<void>((r) => {
      started = r;
    });
  const p = run({
    args: ["-e", "setTimeout(()=>{},80)"],
    healthIntervalMs: 20,
    health: async () => {
      started();
      await active;
      return undefined;
    },
  }).then((r) => {
    finished = true;
    return r;
  });
  await start;
  await sleep(200);
  assert.equal(finished, false);
  release();
  assert.equal((await p).code, 0);
});
test("graceful timeout", async () => {
  const r = await run({
    args: ["-e", "setInterval(()=>{},1000)"],
    timeoutMs: 150,
  });
  assert.equal(r.stopReason, "wall_clock_limit");
  assert.equal(r.forced, false);
});
test("forced timeout of ignoring worker", async () => {
  const r = await run({
    args: ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    timeoutMs: 200,
  });
  assert.equal(r.stopReason, "wall_clock_limit");
  assert.equal(r.forced, true);
});
test("leader exits but ignoring descendant is killed after grace", async () => {
  let descendant = 0,
    stop!: (reason: string) => void;
  const script = `const c=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send({ready:true});setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>process.send({pid:c.pid}));process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
  const r = await run({
    args: ["-e", script],
    registerStop: (f) => {
      stop = f;
      return () => {};
    },
    onMessage: async (m: any) => {
      descendant = m.pid;
      stop("test_stop");
    },
  });
  assert.equal(r.stopReason, "test_stop");
  assert.equal(r.forced, true);
  assert.ok(descendant);
  // The OS may briefly retain an exited descendant until it is reaped.
  await sleep(100);
  assert.throws(() => process.kill(descendant, 0), /ESRCH/);
});
test("stop registration failure cannot orphan worker", async () => {
  const r = await run({
    registerStop: () => {
      throw new Error("registration");
    },
  });
  assert.match(r.stopReason ?? "", /stop_registration_failed/);
});
