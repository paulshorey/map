import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertOverview,
  type OperationsOverview,
} from "../../contracts/ingestion-operations.js";
import {
  assessJournals,
  assessQueue,
  assessWorkers,
} from "../../sql/ingestion-overview-evidence.js";
import type { QueueState } from "../../scripts/ingest/import-queue.js";
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
    worker_liveness: null,
    import_queue: null,
    recent_executions: [],
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

const live = {
  execution_id: "execution-current",
  run_id: "run-current",
  source: "songkick",
  heartbeat_stale: false,
  local_process: "present_identity_unverified" as const,
  identity_verified: true,
  source_locked: true,
  status: "running",
};
const locks = {
  inspected_at: "2026-11-18T07:00:00Z",
  host: "test-host",
  maintenance: { maintenance: false },
  quiescent: false,
  workers: [live],
  source_locks: [{ source: "songkick", database_pid: 12 }],
  admitted_workers: [{ database_pid: 12 }],
  local_script_processes: [],
  process_scan_error: null,
  limitations: "",
};
const job = {
  id: "job-current",
  status: "running" as const,
  execution_id: live.execution_id,
  run_id: live.run_id,
  host: locks.host,
  host_id: null,
  started_at: locks.inspected_at,
  last_health_at: null,
  last_health_evidence: null,
  result: null,
  journal: "job.json",
};

test("a claimed worker needs fresh exact identity and the matching database admission lock", () => {
  assert.equal(assessWorkers(locks).confirmed, 1);
  assert.equal(
    assessWorkers({ ...locks, admitted_workers: [{ database_pid: 13 }] })
      .unconfirmed,
    1,
  );
  assert.equal(
    assessWorkers({ ...locks, workers: [{ ...live, heartbeat_stale: true }] })
      .unconfirmed,
    1,
  );
  assert.equal(
    assessWorkers({
      ...locks,
      workers: [{ ...live, identity_verified: false }],
    }).unconfirmed,
    1,
  );
  assert.equal(
    assessWorkers({
      ...locks,
      workers: [
        { ...live, identity_verified: false, local_process: "remote_unknown" },
      ],
    }).confirmed,
    1,
  );
});

test("a source lock does not confirm competing fresh executions", () => {
  const competing = {
    ...live,
    run_id: "run-other",
    execution_id: "execution-other",
    identity_verified: false,
    local_process: "remote_unknown" as const,
  };
  const ambiguous = assessWorkers({ ...locks, workers: [live, competing] });
  assert.equal(ambiguous.confirmed, 0);
  assert.equal(ambiguous.unconfirmed, 2);
  const resolved = assessWorkers({
    ...locks,
    workers: [live, { ...competing, heartbeat_stale: true }],
  });
  assert.equal(resolved.confirmed, 1);
  assert.equal(resolved.workers[0]?.liveness, "confirmed");
});

test("unfinished journals can reference terminal executions without increasing the worker count", () => {
  const historical = {
    ...job,
    id: "job-older",
    execution_id: "execution-older",
  };
  const current = assessWorkers(locks);
  const evidence = {
    execution_id: historical.execution_id,
    run_id: historical.run_id,
    status: "interrupted",
    stop_reason: "source_lock_recovered",
    finished_at: new Date(locks.inspected_at),
    run_verified_at: null,
    file: "source.json",
  };
  const journals = assessJournals([job, historical], current.workers, [
    evidence,
  ]);
  assert.deepEqual(
    journals.map((row) => row.assessment),
    ["confirmed_active", "terminal_execution"],
  );
  assert.equal(journals[1]?.execution_status, "interrupted");
  assert.equal(
    assessJournals([historical], [], [{ ...evidence, run_id: "other" }])[0]
      ?.assessment,
    "unconfirmed",
  );
});

test("active queue IDs come from the exact job and historical coverage stays distinct", () => {
  const now = locks.inspected_at;
  const entry = {
    file: "current.json",
    category: "music_festival",
    status: "running" as const,
    run_id: null,
    jobs: [job.id],
    quota_pauses: 0,
    started_at: now,
    finished_at: null,
    outcome: null,
    reason: null,
    resets_at: null,
    coverage: "unstarted",
  };
  const queue: QueueState = {
    id: "queue-current",
    status: "running",
    host: locks.host,
    pid: 123,
    message: null,
    created_at: now,
    updated_at: now,
    current: 1,
    entries: [
      {
        ...entry,
        file: "earlier.json",
        status: "succeeded",
        finished_at: now,
        outcome: "succeeded",
        coverage: "complete",
        jobs: [],
      },
      entry,
    ],
  };
  const coverage = new Map([
    ["current.json", "partial"],
    ["earlier.json", "ready_to_verify"],
  ]);
  const workers = assessWorkers(locks).workers;
  const active = assessQueue(
    [queue],
    { held: true, holder: queue.id },
    [job],
    workers,
    coverage,
  );
  assert.equal(active.current?.run_id, live.run_id);
  assert.equal(active.current?.execution_id, live.execution_id);
  assert.equal(active.current?.worker_confirmed, true);
  assert.equal(active.recent_finished[0]?.recorded_coverage, "complete");
  assert.equal(active.recent_finished[0]?.current_coverage, "ready_to_verify");

  const historical = assessQueue(
    [queue],
    { held: false, holder: null },
    [job],
    [],
    coverage,
  );
  assert.equal(historical.active, false);
  assert.equal(historical.evidence, "journal_only");
  const remote = assessQueue(
    [queue],
    { held: true, holder: null },
    [job],
    [],
    coverage,
  );
  assert.equal(remote.active, true);
  assert.equal(remote.journal_available, false);
  assert.equal(remote.current, null);
});
