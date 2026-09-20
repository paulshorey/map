import { test } from "node:test";
import assert from "node:assert/strict";
import { hostname } from "node:os";
import { parseControlArgs, scriptProcesses, localPidState } from "./control.js";

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
