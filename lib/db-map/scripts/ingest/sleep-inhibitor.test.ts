import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { holdSystemAwake } from "./sleep-inhibitor.js";
import { superviseProcess } from "./supervisor-process.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const macOS = { skip: process.platform !== "darwin" };

function ownAssertions(pid: number) {
  return execFileSync("/usr/bin/pmset", ["-g", "assertions"], {
    encoding: "utf8",
  })
    .split(/(?=\s+pid \d+\(caffeinate\):)/)
    .filter((part) =>
      new RegExp(`caffeinate asserting on behalf of Process ID ${pid}\\b`).test(
        part,
      ),
    )
    .join("\n");
}

async function waitForRelease(pid: number) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!ownAssertions(pid)) return;
    await sleep(100);
  }
  assert.equal(ownAssertions(pid), "", "sleep assertion must be released");
}

test(
  "macOS ingestion holds both idle and system sleep assertions",
  macOS,
  async () => {
    const release = await holdSystemAwake();
    try {
      let assertions = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        assertions = ownAssertions(process.pid);
        if (assertions.includes("PreventSystemSleep")) break;
        await sleep(100);
      }
      assert.match(assertions, /PreventUserIdleSystemSleep/);
      assert.match(assertions, /PreventSystemSleep/);
      await sleep(1000);
      assert.match(ownAssertions(process.pid), /PreventSystemSleep/);
    } finally {
      release();
      await waitForRelease(process.pid);
    }
  },
);

async function guardedWorker(
  action: (
    workerPid: number,
    guardPid: number,
    stop: (reason: string) => void,
  ) => void,
) {
  const dir = await mkdtemp(join(tmpdir(), "ingest-sleep-"));
  const require = createRequire(import.meta.url);
  const guardUrl = new URL("./sleep-inhibitor.ts", import.meta.url).href;
  const source = `
    import { holdSystemAwake } from ${JSON.stringify(guardUrl)};
    import { execFileSync } from "node:child_process";
    const release = await holdSystemAwake();
    const assertions = ${ownAssertions.toString()};
    for (const signal of ["SIGTERM", "SIGINT"]) {
      process.on(signal, () => {
        console.log("graceful-stop-requested", signal);
        setTimeout(() => {
          if (!assertions(process.pid).includes("PreventSystemSleep")) {
            throw new Error("sleep assertion lost before checkpoint");
          }
          console.log("checkpoint-committed");
          release();
          process.exit(2);
        }, 300);
      });
    }
    setInterval(() => {}, 1000);
    for (let attempt = 0; attempt < 20; attempt++) {
      const active = assertions(process.pid);
      if (active.includes("PreventSystemSleep")) {
        const guardPid = Number(active.match(/\\bpid (\\d+)\\(caffeinate\\):/)[1]);
        process.send({ workerPid: process.pid, guardPid });
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  `;
  let workerPid = 0;
  let stop!: (reason: string) => void;
  try {
    const result = await superviseProcess({
      command: process.execPath,
      args: [
        "--import",
        require.resolve("tsx"),
        "--input-type=module",
        "-e",
        source,
      ],
      cwd: dir,
      log: join(dir, "worker.log"),
      timeoutMs: 5000,
      graceMs: 1000,
      healthIntervalMs: 3600_000,
      health: async () => undefined,
      onStart: async (pid) => {
        workerPid = pid;
      },
      onMessage: async (message) => {
        const ready = message as { workerPid: number; guardPid: number };
        assert.equal(ready.workerPid, workerPid);
        assert.ok(Number.isSafeInteger(ready.guardPid) && ready.guardPid > 0);
        action(workerPid, ready.guardPid, stop);
      },
      registerStop: (callback) => {
        stop = callback;
        return () => {};
      },
    });
    assert.ok(workerPid);
    await waitForRelease(workerPid);
    return { ...result, log: await readFile(join(dir, "worker.log"), "utf8") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test(
  "supervisor SIGTERM preserves the in-flight checkpoint and releases the assertion",
  macOS,
  async () => {
    const result = await guardedWorker((_pid, _guardPid, stop) =>
      stop("operator_stop"),
    );
    assert.equal(result.code, 2);
    assert.equal(result.stopReason, "operator_stop");
    assert.equal(result.forced, false);
    assert.match(result.log, /graceful-stop-requested SIGTERM/);
    assert.match(result.log, /checkpoint-committed/);
    assert.doesNotMatch(result.log, /sleep prevention lost/);
  },
);

test(
  "worker-group SIGINT preserves the in-flight checkpoint",
  macOS,
  async () => {
    const result = await guardedWorker((pid) => process.kill(-pid, "SIGINT"));
    assert.equal(result.code, 2);
    assert.equal(result.forced, false);
    assert.match(result.log, /graceful-stop-requested SIGINT/);
    assert.match(result.log, /checkpoint-committed/);
  },
);

test(
  "unexpected sleep guard loss still exits the worker for recovery",
  macOS,
  async () => {
    const result = await guardedWorker((_pid, guardPid) =>
      process.kill(guardPid, "SIGTERM"),
    );
    assert.equal(result.code, 1);
    assert.match(result.log, /sleep prevention lost; exiting for recovery/);
    assert.doesNotMatch(result.log, /checkpoint-committed/);
  },
);

test("the sleep assertion ends after abrupt worker death", macOS, async () => {
  const result = await guardedWorker((pid) => process.kill(-pid, "SIGKILL"));
  assert.equal(result.signal, "SIGKILL");
  assert.doesNotMatch(result.log, /checkpoint-committed/);
});
