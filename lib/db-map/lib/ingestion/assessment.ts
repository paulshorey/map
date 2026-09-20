export type Coverage =
  | "unstarted"
  | "partial"
  | "ready_to_verify"
  | "complete"
  | "unknown";
export interface Evidence {
  missing_at: unknown;
  scan_error: string | null;
  disposition: string;
  category_slug: string | null;
  format: string;
  file_sha256: string | null;
  has_history: boolean;
  current_version: boolean;
  extraction_complete: boolean;
  records: number;
  ready: number;
  verified: number;
  invalid: number;
  normalization_failed: number;
  normalized: number;
  excluded: number;
  coordinates: number;
  embedded: number;
  linked: number;
  latest_run: {
    id: string;
    managed: boolean;
    status: string;
    current_stage: string;
    heartbeat_at: string | Date | null;
    options: Record<string, unknown>;
    file_sha256: string;
    extractor_version: string;
    pipeline_versions: Record<string, string>;
    category_slug: string;
    stop_requested: boolean;
    fatal_error: string | null;
  } | null;
}
export function assessFile(e: Evidence, now = Date.now()) {
  let coverage: Coverage = "partial";
  const freshness = e.missing_at
    ? "missing"
    : e.scan_error
      ? "scan_error"
      : !e.current_version && e.has_history
        ? "changed"
        : e.invalid
          ? "stale_outputs"
          : "current";
  if (
    !e.file_sha256 ||
    e.scan_error ||
    !["json", "jsonl", "csv"].includes(e.format)
  )
    coverage = "unknown";
  else if (!e.current_version) coverage = "unstarted";
  else if (
    e.extraction_complete &&
    e.records > 0 &&
    e.verified === e.records &&
    e.ready === e.records
  )
    coverage = "complete";
  else if (e.extraction_complete && e.records > 0 && e.ready === e.records)
    coverage = "ready_to_verify";
  const run = e.latest_run;
  const suspected =
    run?.status === "running" &&
    (!run.managed ||
      !run.heartbeat_at ||
      now - new Date(run.heartbeat_at).getTime() > 30000);
  const execution = suspected
    ? "suspected_interrupted"
    : (run?.status ?? "none");
  let next = "Start file ingestion";
  if (e.missing_at) next = "Restore file or retain as historical evidence";
  else if (e.scan_error) next = "Resolve scan error and refresh inventory";
  else if (!["json", "jsonl", "csv"].includes(e.format))
    next = "Convert to a supported capture format";
  else if (e.disposition !== "import")
    next =
      e.disposition === "needs_review"
        ? "Review file and choose category/disposition"
        : "Excluded from work queue; see operator notes";
  else if (!e.category_slug) next = "Choose an explicit category";
  else if (execution === "running")
    next = run?.stop_requested
      ? "Pause requested; waiting for current unit"
      : "Monitor the active run";
  else if (freshness === "changed")
    next = "Start a new run for changed file/extractor";
  else if (coverage === "complete")
    next = "Structurally complete; review data quality separately";
  else if (e.invalid)
    next =
      "Inspect changed observations/artifacts; start an explicit repair run";
  else if (e.normalization_failed)
    next = "Inspect normalization errors; fix cause and resume";
  else if (
    run &&
    [
      "failed",
      "paused",
      "waiting_budget",
      "partial",
      "suspected_interrupted",
    ].includes(execution)
  )
    next = "Inspect the last attempt, then resume its original scope";
  else if (coverage === "ready_to_verify")
    next = "Verify the whole file with --from report";
  else if (!e.extraction_complete)
    next = "Finish full extraction; a sample cannot establish file coverage";
  else if (e.normalized < e.records) next = "Continue normalization";
  else if (e.coordinates < e.records - e.excluded)
    next = "Resolve missing coordinates";
  else if (e.embedded < e.records - e.excluded) next = "Continue embedding";
  else if (e.linked < e.records - e.excluded)
    next = "Continue matching and canonical builds";
  const attention = Boolean(
    e.scan_error ||
    e.missing_at ||
    e.invalid ||
    e.normalization_failed ||
    ["failed", "waiting_budget", "partial", "suspected_interrupted"].includes(
      execution,
    ),
  );
  return {
    coverage,
    freshness,
    execution,
    next,
    attention,
    total: e.extraction_complete ? e.records : null,
    percent:
      e.extraction_complete && e.records > 0
        ? Math.floor((e.verified / e.records) * 100)
        : null,
  };
}
export function shellQuote(value: string) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
