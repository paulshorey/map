import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  __setRequestTimeoutForTests,
  __setSpawnForTests,
  managedCodexPath,
  notifyParent,
  probeParent,
} from "./codex-notify.js";

function fake(
  replies: Array<{
    code?: number;
    stdout?: string;
    stderr?: string;
    hang?: boolean;
  }>,
  calls: Array<{ command: string; args: string[] }>,
) {
  return ((command: string, args: string[]) => {
    calls.push({ command, args });
    const reply = replies.shift() ?? {};
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal: NodeJS.Signals) => {
      setImmediate(() => child.emit("exit", null, signal));
      return true;
    };
    if (!reply.hang)
      setImmediate(() => {
        if (reply.stdout) child.stdout.write(reply.stdout);
        if (reply.stderr) child.stderr.write(reply.stderr);
        child.emit("exit", reply.code ?? 0, null);
      });
    return child;
  }) as any;
}

test("managed daemon preflight starts and verifies matching versions", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  __setSpawnForTests(
    fake(
      [
        { stdout: '{"status":"already_running"}' },
        {
          stdout:
            '{"status":"running","cliVersion":"1","appServerVersion":"1"}',
        },
      ],
      calls,
    ),
  );
  assert.deepEqual(await probeParent("thread"), { status: "ready" });
  assert.equal(calls[0]?.command, managedCodexPath());
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["app-server", "daemon", "start"],
      ["app-server", "daemon", "version"],
    ],
  );
});

test("terminal delivery uses the shared queue without model overrides", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  __setSpawnForTests(fake([{ stdout: "queued" }], calls));
  assert.deepEqual(await notifyParent("thread", "event", "evidence"), {
    status: "sent",
  });
  assert.deepEqual(calls[0]?.args, [
    "queue",
    "--remote",
    "unix://",
    "--thread",
    "thread",
    "--message",
    "[event] evidence",
  ]);
  assert.equal(calls[0]?.args.includes("--model"), false);
});

test("explicit queue rejection defers and transport ambiguity is uncertain", async () => {
  const rejected: Array<{ command: string; args: string[] }> = [];
  __setSpawnForTests(
    fake([{ code: 1, stderr: "thread unavailable" }], rejected),
  );
  assert.deepEqual(await notifyParent("thread", "event", "evidence"), {
    status: "deferred",
    reason: "thread unavailable",
  });

  const timedOut: Array<{ command: string; args: string[] }> = [];
  __setRequestTimeoutForTests(10);
  try {
    __setSpawnForTests(fake([{ hang: true }], timedOut));
    assert.equal(
      (await notifyParent("thread", "event", "evidence")).status,
      "uncertain",
    );
    assert.equal(timedOut.length, 1);
  } finally {
    __setRequestTimeoutForTests(30_000);
  }
});
