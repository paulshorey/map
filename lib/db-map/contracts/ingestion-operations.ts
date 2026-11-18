/** Versioned, loopback-only human/agent operations contract. Unknown evidence is explicit. */
export interface OperationsOverview {
  schema_version: 1;
  observed_at: string;
  components: {
    database: {
      status: "available" | "unknown";
      observed_at?: string;
      message?: string;
    };
    local: {
      observed_at: string;
      jobs: unknown[];
      claims: unknown[];
      errors: string[];
    };
  };
  summary: null | {
    discovered: number;
    intended: number;
    complete: number;
    active: number;
    partial: number;
    unstarted: number;
    ready_to_verify: number;
    coverage_counts: Record<string, number>;
    review: number;
    excluded: number;
    degraded_records: number;
  };
  worker_liveness: null | {
    confirmed: number;
    unconfirmed: number;
    workers: Array<{ liveness: "confirmed" | "unconfirmed" }>;
  };
  import_queue: null | {
    active: boolean;
    evidence: "lock" | "starting" | "journal_only" | "none";
    id: string | null;
    recorded_status: string | null;
    journal_available: boolean;
    updated_at: string | null;
    message: string | null;
    counts: Record<string, number> | null;
    current: unknown;
    recent_finished: unknown[];
  };
  recent_executions: unknown[];
  decision: { action: string; reason?: string; [key: string]: unknown };
  interventions: Array<{
    code: string;
    scope: string;
    severity: string;
    [key: string]: unknown;
  }>;
  improvements: Array<{ code: string; [key: string]: unknown }>;
  control?: { maintenance: unknown };
  files: unknown[];
  [key: string]: unknown;
}
export function assertOverview(value: OperationsOverview): void {
  if (
    value.schema_version !== 1 ||
    !["available", "unknown"].includes(value.components.database.status) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.interventions) ||
    !Array.isArray(value.recent_executions)
  )
    throw new Error("Invalid ingestion overview contract");
  if (
    value.components.database.status === "unknown" &&
    (value.decision.action !== "inspect" ||
      value.summary !== null ||
      value.worker_liveness !== null ||
      value.import_queue !== null)
  )
    throw new Error("Unknown evidence must block automatic launch");
}
