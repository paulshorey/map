import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import {
  parseControlArgs,
  scriptProcesses,
  localPidState,
  canReconcile,
} from "./control.js";
import { isLocalHost } from "./host-identity.js";

test("control mutations require explicit, unambiguous scope and bounded waits", () => {
  assert.throws(() => parseControlArgs(["stop"]));
  assert.throws(() =>
    parseControlArgs([
      "stop",
      "--all",
      "--run",
      "00000000-0000-0000-0000-000000000001",
    ]),
  );
  assert.throws(() => parseControlArgs(["maintenance", "enter"]));
  assert.throws(() => parseControlArgs(["maintenance", "exit"]));
  assert.throws(() =>
    parseControlArgs(["stop", "--all", "--wait-seconds", "61"]),
  );
  assert.throws(() => parseControlArgs(["list", "--all"]));
  assert.equal(
    parseControlArgs(["stop", "--all", "--wait-seconds", "0"]).waitSeconds,
    0,
  );
});
test("process discovery ignores shell text/read-only controls and finds writable scripts", () => {
  assert.deepEqual(
    scriptProcesses(`
101 1 /usr/local/bin/node --import /tmp/tsx.mjs scripts/ingest/run.ts --resume abc
102 1 node /repo/lib/db-map/scripts/ingest/normalize.ts --limit 1
103 1 node scripts/ingest/control.ts list
104 1 /bin/zsh -c echo node scripts/ingest/run.ts
105 1 node scripts/ingest/status.ts
106 1 node scripts/ingest/control.test.ts
107 1 node scripts/import-kml.ts fixture.kml
108 1 node scripts/ingest/inventory.ts --json
109 1 node scripts/ingest/supervise.ts worker --job abc
110 1 node scripts/ingest/queue.ts --json
`),
    [
      { pid: 101, ppid: 1, script: "ingest/run" },
      { pid: 102, ppid: 1, script: "ingest/normalize" },
      { pid: 107, ppid: 1, script: "import-kml" },
    ],
  );
  assert.equal(localPidState("some-other-host", process.pid), "remote_unknown");
  assert.equal(
    localPidState(hostname(), process.pid),
    "present_identity_unverified",
  );
});

test("host identity accepts exact and mDNS aliases without merging different hosts", () => {
  assert.equal(isLocalHost("Pauls-MacBook-Pro", "Pauls-MacBook-Pro"), true);
  assert.equal(
    isLocalHost("Pauls-MacBook-Pro.local", "Pauls-MacBook-Pro"),
    true,
  );
  assert.equal(
    isLocalHost("Pauls-MacBook-Pro", "Pauls-MacBook-Pro.local"),
    true,
  );
  assert.equal(
    isLocalHost("PAULS-MACBOOK-PRO.LOCAL.", "pauls-macbook-pro"),
    true,
  );
  assert.equal(isLocalHost("Host.Example.COM", "host.example.com"), true);
  assert.equal(
    isLocalHost("Pauls-MacBook-Pro-2.local", "Pauls-MacBook-Pro"),
    false,
  );
  assert.equal(
    isLocalHost("Pauls-MacBook-Pro.local.evil", "Pauls-MacBook-Pro"),
    false,
  );
  assert.equal(isLocalHost("host.example.com", "host.other.com"), false);
  assert.equal(isLocalHost("host.example.com", "host"), false);
});

test("a live mDNS worker remains present; an absent mDNS worker can reconcile only when quiescent", () => {
  const host = `${hostname().replace(/\.local$/i, "")}.local`;
  const executionId = "test-execution";
  const live = localPidState(host, process.pid);
  assert.equal(live, "present_identity_unverified");
  assert.equal(
    canReconcile(
      {
        quiescent: true,
        workers: [{ execution_id: executionId, local_process: live }],
      },
      executionId,
    ),
    false,
  );
  const absent = localPidState(host, 2147483647);
  assert.equal(absent, "absent");
  const snapshot: Parameters<typeof canReconcile>[0] = {
    quiescent: true,
    workers: [{ execution_id: executionId, local_process: absent }],
  };
  assert.equal(canReconcile(snapshot, executionId), true);
  assert.equal(
    canReconcile({ ...snapshot, quiescent: false }, executionId),
    false,
  );
  assert.equal(canReconcile(snapshot, "other-execution"), false);
});
