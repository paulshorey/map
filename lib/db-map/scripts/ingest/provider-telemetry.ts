import { randomUUID } from "node:crypto";
import { currentAttempt, errorDetails } from "./execution.js";
import { llmLimiter } from "./concurrency.js";
import { withDatabaseOperation } from "./database-telemetry.js";
type Context = NonNullable<ReturnType<typeof currentAttempt>>;
export interface ProviderCall {
  id: string;
  context: Context;
  started: number;
  queued: number;
  contexts: Context[];
  serviceTier?: string;
  provider: string;
  operation: string;
  requestStarted?: boolean;
  httpStatus?: number;
  endAttempted?: boolean;
}
function lifecycle(call: ProviderCall, phase: string, detail: object = {}) {
  call.context.execution.recordProviderLifecycle?.({
    call_id: call.id,
    attempt_id: call.context.attemptId,
    provider: call.provider,
    operation: call.operation,
    phase,
    request_started: call.requestStarted ?? null,
    http_status: call.httpStatus ?? null,
    ...detail,
  });
}
function diagnosticError(error: unknown) {
  const detail = errorDetails(error);
  // Arbitrary provider/driver messages can contain endpoints or input text.
  return {
    name: detail.name,
    code: detail.code,
    status: detail.status,
    retryable: detail.retryable,
    database: detail.database,
  };
}
function attributeFailure(
  call: ProviderCall,
  error: unknown,
  phase: string,
  providerError?: unknown,
) {
  const detail = {
    call_id: call.id,
    provider: call.provider,
    operation: call.operation,
    phase,
    request_started: call.requestStarted ?? null,
    http_status: call.httpStatus ?? null,
  };
  try {
    if (error instanceof Error) {
      Object.assign(error, { provider_call: detail });
      if (providerError && providerError !== error)
        Object.assign(error, {
          provider_error: diagnosticError(providerError),
        });
    }
  } catch {
    /* Preserve frozen/foreign errors. */
  }
  lifecycle(call, phase, { error: diagnosticError(error) });
  return error;
}
/** Local invocation is observed; remote delivery/billing can still be unknown. */
export function providerRequestStarted(call: ProviderCall | null) {
  if (!call) return;
  call.requestStarted = true;
  lifecycle(call, "request_started");
}
export function providerResponseReceived(
  call: ProviderCall | null,
  status: number,
) {
  if (!call) return;
  call.httpStatus = status;
  lifecycle(call, "response_received");
}
export async function beginProviderCall(
  provider: string,
  operation: string,
  model: string | null,
  contexts: Context[] = currentAttempt() ? [currentAttempt()!] : [],
  serviceTier?: string,
): Promise<ProviderCall | null> {
  const ctx = contexts[0];
  if (!ctx) return null;
  const id = randomUUID(),
    started = Date.now();
  const call: ProviderCall = {
    id,
    context: ctx,
    started,
    queued: started,
    contexts,
    serviceTier,
    provider,
    operation,
  };
  lifecycle(call, "preflight_started");
  try {
    await withDatabaseOperation("provider_preflight_call", () =>
      ctx.execution.db.query(
        `INSERT INTO research_ingest_provider_calls(id,run_id,execution_id,provider,operation,model,records,concurrency)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          id,
          ctx.runId,
          ctx.execution.id,
          provider,
          operation,
          model,
          contexts.length,
          JSON.stringify({
            ...llmLimiter.snapshot(),
            ...(serviceTier ? { service_tier_requested: serviceTier } : {}),
          }),
        ],
      ),
    );
    await withDatabaseOperation("provider_preflight_items", () =>
      ctx.execution.db.query(
        `INSERT INTO research_ingest_provider_call_items(call_id,attempt_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
        [id, contexts.map((x) => x.attemptId)],
      ),
    );
    lifecycle(call, "preflight_recorded");
    return call;
  } catch (error) {
    call.requestStarted = false;
    throw attributeFailure(call, error, "preflight_failed");
  }
}
export function quotaHeaders(headers: Headers) {
  return Object.fromEntries(
    [...headers.entries()].filter(([key]) =>
      /^x-ratelimit-|^retry-after$/.test(key),
    ),
  );
}
export async function endProviderCall(
  call: ProviderCall | null,
  result: {
    queueMs?: number;
    latencyMs?: number;
    promptTokens?: number | null;
    cachedTokens?: number | null;
    completionTokens?: number | null;
    reasoningTokens?: number | null;
    cost?: number | null;
    status?: number;
    headers?: Headers;
    error?: unknown;
    serviceTier?: string | null;
  },
) {
  if (!call) return;
  // Provider adapters catch result-bookkeeping failures in their outer catch too.
  // Never repeat an UPDATE with an unknown commit outcome or mask its first error.
  if (call.endAttempted) return;
  call.endAttempted = true;
  call.httpStatus = result.status ?? call.httpStatus;
  lifecycle(call, "result_recording");
  for (const ctx of call.contexts) {
    ctx.providerMs =
      (ctx.providerMs ?? 0) + (result.latencyMs ?? Date.now() - call.started);
    ctx.providerQueueMs = (ctx.providerQueueMs ?? 0) + (result.queueMs ?? 0);
  }
  try {
    await withDatabaseOperation("provider_result", () =>
      call.context.execution.db.query(
        `UPDATE research_ingest_provider_calls SET status=$2,finished_at=clock_timestamp(),queue_ms=$3,
    latency_ms=$4,prompt_tokens=$5,cached_tokens=$6,completion_tokens=$7,reasoning_tokens=$8,estimated_cost_usd=$9,
    http_status=$10,quota=$11,concurrency=$12,error=$13 WHERE id=$1`,
        [
          call.id,
          result.error ? "failed" : "succeeded",
          result.queueMs ?? 0,
          result.latencyMs ?? Date.now() - call.started,
          result.promptTokens ?? null,
          result.cachedTokens ?? null,
          result.completionTokens ?? null,
          result.reasoningTokens ?? null,
          result.cost ?? null,
          result.status ?? null,
          JSON.stringify(result.headers ? quotaHeaders(result.headers) : {}),
          JSON.stringify({
            ...llmLimiter.snapshot(),
            ...(call.serviceTier
              ? {
                  service_tier_requested: call.serviceTier,
                  service_tier_returned: result.serviceTier ?? null,
                }
              : {}),
          }),
          result.error ? JSON.stringify(errorDetails(result.error)) : null,
        ],
      ),
    );
    lifecycle(call, "result_recorded", {
      outcome: result.error ? "failed" : "succeeded",
    });
  } catch (error) {
    throw attributeFailure(
      call,
      error,
      "result_recording_failed",
      result.error,
    );
  }
}
