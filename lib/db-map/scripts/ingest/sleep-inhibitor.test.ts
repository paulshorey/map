import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { holdSystemAwake } from "./sleep-inhibitor.js";

test(
  "macOS ingestion holds both idle and system sleep assertions",
  {
    skip: process.platform !== "darwin",
  },
  async () => {
    const release = await holdSystemAwake();
    try {
      const ownAssertions = () =>
        execFileSync("pmset", ["-g", "assertions"], {
          encoding: "utf8",
        })
          .split(/(?=\s+pid \d+\(caffeinate\):)/)
          .filter((part) =>
            part.includes(
              `caffeinate asserting on behalf of Process ID ${process.pid}`,
            ),
          )
          .join("\n");
      let assertions = "";
      for (let attempt = 0; attempt < 20; attempt++) {
        assertions = ownAssertions();
        if (assertions.includes("PreventSystemSleep")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.match(assertions, /PreventUserIdleSystemSleep/);
      assert.match(assertions, /PreventSystemSleep/);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.match(ownAssertions(), /PreventSystemSleep/);
    } finally {
      release();
    }
  },
);
