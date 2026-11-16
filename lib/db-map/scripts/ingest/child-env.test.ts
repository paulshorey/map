import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { childEnv } from "./child-env.js";

test("child processes never inherit node --watch dependency reporting", () => {
  const before = process.env.WATCH_REPORT_DEPENDENCIES;
  process.env.WATCH_REPORT_DEPENDENCIES = "1";
  try {
    const env = childEnv({ EXTRA: "x" });
    assert.equal(env.WATCH_REPORT_DEPENDENCIES, undefined);
    assert.equal(env.EXTRA, "x");
    assert.equal(env.PATH, process.env.PATH);
    assert.equal(process.env.WATCH_REPORT_DEPENDENCIES, "1", "the parent's own environment is untouched");
  } finally {
    if (before === undefined) delete process.env.WATCH_REPORT_DEPENDENCIES;
    else process.env.WATCH_REPORT_DEPENDENCIES = before;
  }
});

// The failure itself: a child that keeps an IPC channel, loses its parent's end, then loads
// a module. With the variable inherited it dies; with childEnv() it does not.
const script = `
  process.disconnect();
  setTimeout(() => { require("node:zlib"); require("node:dns"); console.log("loaded"); }, 50);
`;
const run = (env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env,
    });
    let out = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
test("a detached-style child survives loading modules after its IPC channel closes", async () => {
  const clean = await run(childEnv());
  assert.equal(clean.code, 0, clean.out);
  assert.match(clean.out, /loaded/);
});
