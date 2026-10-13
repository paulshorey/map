import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertOverview,
  type OperationsOverview,
} from "../../contracts/ingestion-operations.js";
import { performanceOpportunities } from "../../sql/ingestion-overview.js";
test("unknown database evidence cannot imply launch or empty healthy summary", () => {
  const view: OperationsOverview = {
    schema_version: 1,
    observed_at: new Date().toISOString(),
    components: {
      database: { status: "unknown" },
      local: { observed_at: "now", jobs: [], claims: [], errors: [] },
    },
    summary: null,
    decision: { action: "inspect" },
    interventions: [],
    improvements: [],
    files: [],
  };
  assert.doesNotThrow(() => assertOverview(view));
  assert.throws(
    () => assertOverview({ ...view, decision: { action: "start" } }),
    /Unknown evidence/,
  );
});
test("measured serial waiting and hypothetical quality tuning remain distinct", () => {
  const suggestions = performanceOpportunities(
    [
      {
        operation: "normalize",
        mean_latency_ms: 18000,
        mean_completion_tokens: 2400,
      },
    ],
    1,
    26000,
  );
  assert.equal(suggestions[0]?.code, "serial_provider_wait");
  assert.equal(suggestions[0]?.confidence, "measured");
  assert.equal(suggestions.at(-1)?.confidence, "hypothesis");
  assert.equal(performanceOpportunities([], 4, 1000).length, 0);
});
