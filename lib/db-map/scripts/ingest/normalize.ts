/**
 * Hybrid deterministic + DeepSeek research normalization.
 *
 * One real research record is sent per LLM request with two reviewed examples.
 * Deterministic facts and candidate validation always gate activation.
 */
import { getDb } from "../../lib/db/postgres.js";
import { runHybridNormalize, type NormalizeOptions } from "./normalize/runner.js";

function parseArgs(argv: string[]): NormalizeOptions {
  const opts: NormalizeOptions = {
    noLlm: false,
    shadow: false,
    reprocess: false,
    retryFailed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === "--source") opts.source = value();
    else if (arg === "--limit") opts.limit = Number(value());
    else if (arg === "--max-requests") opts.maxRequests = Number(value());
    else if (arg === "--max-cost-usd") opts.maxCostUsd = Number(value());
    else if (arg === "--no-llm") opts.noLlm = true;
    else if (arg === "--shadow") opts.shadow = true;
    else if (arg === "--reprocess") opts.reprocess = true;
    else if (arg === "--retry-failed") opts.retryFailed = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const [name, value] of [
    ["--limit", opts.limit],
    ["--max-requests", opts.maxRequests],
    ["--max-cost-usd", opts.maxCostUsd],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Invalid ${name}: ${value}`);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  try {
    const stats = await runHybridNormalize(db, opts);
    console.log(
      `Normalize${opts.source ? ` ${opts.source}` : ""}: selected=${stats.selected} ` +
        `processed=${stats.processed} cache_hits=${stats.cacheHits} ` +
        `llm_requests=${stats.llmRequests} accepted=${stats.accepted} ` +
        `degraded=${stats.degraded} rejected=${stats.rejected} failed=${stats.failed} ` +
        `cost_usd=${stats.costUsd.toFixed(6)}` +
        `${stats.stoppedByBudget ? " [budget reached; rerun to continue]" : ""}`,
    );
    if (stats.failed > 0) process.exitCode = 2;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("Normalize failed:", error);
  process.exit(1);
});
