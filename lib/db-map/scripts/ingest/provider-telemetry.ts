import { randomUUID } from "node:crypto";
import { currentAttempt, errorDetails } from "./execution.js";
import { llmLimiter } from "./concurrency.js";
type Context = NonNullable<ReturnType<typeof currentAttempt>>;
export interface ProviderCall {
  id: string;
  context: Context;
  started: number;
  queued: number;
  contexts: Context[];
  serviceTier?: string;
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
  await ctx.execution.db.query(
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
  );
  await ctx.execution.db.query(
    `INSERT INTO research_ingest_provider_call_items(call_id,attempt_id) SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [id, contexts.map((x) => x.attemptId)],
  );
  return { id, context: ctx, started, queued: started, contexts, serviceTier };
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
  for (const ctx of call.contexts) {
    ctx.providerMs =
      (ctx.providerMs ?? 0) + (result.latencyMs ?? Date.now() - call.started);
    ctx.providerQueueMs = (ctx.providerQueueMs ?? 0) + (result.queueMs ?? 0);
  }
  await call.context.execution.db.query(
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
  );
}
