import type { InventorySnapshot } from "../../sql/ingestion-inventory.js";

type File = InventorySnapshot["files"][number];
export type QueueAction =
  | "inspect"
  | "verify"
  | "start"
  | "review"
  | "blocked"
  | "complete";

/** Recommendations only. Admission and source locks are checked again by the worker. */
export function queueItem(file: File) {
  const run = file.resume_run;
  const fullScope =
    run &&
    run.options.limit == null &&
    !run.options.record &&
    !run.options.shadow &&
    !run.options.retryFailed;
  let action: QueueAction;
  let reason = file.next;
  let runArgs: string[] | null = null;
  const start = [file.logical_path, "--category", file.category_slug ?? ""];
  if (
    file.missing_at ||
    file.scan_error ||
    !file.file_sha256 ||
    !["json", "jsonl", "csv"].includes(file.format)
  )
    action = "blocked";
  else if (file.disposition !== "import" || !file.category_slug)
    action = file.disposition === "needs_review" ? "review" : "blocked";
  else if (file.coverage === "complete") action = "complete";
  else if (["running", "suspected_interrupted"].includes(file.execution))
    action = "inspect";
  else if (file.invalid || file.normalization_failed) action = "inspect";
  else if (file.coverage === "ready_to_verify") {
    action = "verify";
    runArgs = [...start, "--from", "report"];
  } else if (fullScope) {
    // A failure or operator pause needs a decision, not an automatic retry.
    action = "inspect";
    reason =
      "Inspect unfinished full-file work, its stop reason and remaining budgets; resume this UUID after resolving the cause";
  } else if (file.commands.start) {
    action = "start";
    runArgs = start;
    if (file.latest_run)
      reason =
        "Previous selection cannot finish the file; start a full run and reuse valid outputs";
  } else action = "blocked";
  return {
    id: file.id,
    file: file.logical_path,
    source: file.source_slug,
    category: file.category_slug,
    priority: file.priority,
    disposition: file.disposition,
    action,
    reason,
    coverage: file.coverage,
    execution: file.execution,
    total: file.total,
    normalized: file.normalized,
    excluded: file.excluded,
    linked: file.linked,
    verified: file.verified,
    degraded: file.degraded,
    notes: file.notes,
    updated_at: file.updated_at,
    latest_run_id: file.latest_run?.id ?? null,
    continuation_run_id: fullScope ? run.id : null,
    inspect: run
      ? `pnpm --silent --filter @lib/db-map ingest:status --run ${run.id} --json`
      : file.commands.status,
    resume_args: fullScope ? ["--resume", run.id] : null,
    run_args: runArgs,
    requires: runArgs
      ? [
          "review_source_shape_and_identity",
          "explicit_provider_budgets",
          "verified_native_completion",
        ]
      : [],
  };
}

export function buildImportQueue(
  snapshot: InventorySnapshot,
  control: {
    quiescent: boolean;
    maintenance: { maintenance: boolean; reason: string | null };
  },
) {
  const rank: Record<QueueAction, number> = {
    inspect: 0,
    verify: 1,
    start: 2,
    review: 3,
    blocked: 4,
    complete: 5,
  };
  const items = snapshot.files
    .map(queueItem)
    .sort(
      (a, b) =>
        rank[a.action] - rank[b.action] ||
        b.priority - a.priority ||
        a.file.localeCompare(b.file),
    );
  const launchAllowed = !control.maintenance.maintenance && control.quiescent;
  return {
    schema_version: 1,
    inspected_at: snapshot.inspectedAt,
    admission: {
      launch_allowed: launchAllowed,
      reason: control.maintenance.maintenance
        ? `Maintenance: ${control.maintenance.reason}`
        : !control.quiescent
          ? "Worker/process evidence is not quiescent; inspect control before launch"
          : null,
      snapshot_only: true,
    },
    counts: Object.fromEntries(
      Object.keys(rank).map((action) => [
        action,
        items.filter((item) => item.action === action).length,
      ]),
    ),
    next: launchAllowed
      ? (items.find((item) =>
          ["inspect", "verify", "start", "review"].includes(item.action),
        ) ?? null)
      : null,
    items,
  };
}
