/**
 * File-first POI ingestion orchestrator.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:run <docs/poi/...json|jsonl|csv> --category <slug> [options]
 *
 * --category is required on every run. Category is never inferred from path or raw data.
 */
import { getDb } from "../../lib/db/postgres.js";
import { assertValidCategory, listCategorySlugs } from "./taxonomy.js";
import {
  runOrchestration,
  type IngestStage,
  type OrchestratorOptions,
} from "./orchestrator.js";

const STAGES = new Set<IngestStage>([
  "extract",
  "normalize",
  "geocode",
  "embed",
  "match",
  "canonical",
  "consolidate",
  "verify",
  "report",
]);

function stage(value: string, flag: string): IngestStage {
  if (!STAGES.has(value as IngestStage))
    throw new Error(`Invalid ${flag}: ${value}`);
  return value as IngestStage;
}

function usageError(message: string): never {
  console.error(message);
  console.error(
    "Usage: ingest:run <docs/poi/...json|jsonl|csv> --category <slug> [options]",
  );
  console.error(`Known categories: ${listCategorySlugs().join(", ")}`);
  process.exit(1);
}

function parseArgs(argv: string[]): OrchestratorOptions {
  const file = argv[0]?.startsWith("--") ? "" : (argv[0] ?? "");
  const opts: OrchestratorOptions = {
    file,
    category: "",
    dryRun: false,
    shadow: false,
    retryFailed: false,
    noLlm: false,
  };
  for (let i = file ? 1 : 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--"))
        throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === "--resume") opts.resume = value();
    else if (arg === "--record") opts.record = value();
    else if (arg === "--consolidate") opts.consolidate = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--shadow") opts.shadow = true;
    else if (arg === "--retry-failed") opts.retryFailed = true;
    else if (arg === "--no-llm") opts.noLlm = true;
    else if (arg === "--category") opts.category = value();
    else if (arg === "--limit") opts.limit = Number(value());
    else if (arg === "--stop-after") opts.stopAfter = stage(value(), arg);
    else if (arg === "--from") opts.fromStage = stage(value(), arg);
    else if (arg === "--reprocess") {
      const selected = value();
      opts.reprocess = selected === "all" ? "all" : stage(selected, arg);
    } else if (arg === "--max-llm-requests")
      opts.maxLlmRequests = Number(value());
    else if (arg === "--max-cost-usd") opts.maxCostUsd = Number(value());
    else if (arg === "--geocode-limit") opts.geocodeLimit = Number(value());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.resume) {
    if (
      file ||
      opts.category ||
      opts.record ||
      opts.fromStage ||
      opts.reprocess ||
      opts.noLlm ||
      opts.shadow ||
      opts.retryFailed ||
      opts.limit !== undefined ||
      opts.consolidate
    ) {
      throw new Error(
        "--resume preserves scope/options; only --stop-after, --dry-run and provider budgets may be overridden",
      );
    }
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(opts.resume))
      throw new Error("--resume requires a run UUID");
  } else if (!file || !opts.category) {
    usageError("Missing required --category <slug>.");
  }
  try {
    if (!opts.resume) assertValidCategory(opts.category);
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  for (const [name, number] of [
    ["--limit", opts.limit],
    ["--max-llm-requests", opts.maxLlmRequests],
    ["--max-cost-usd", opts.maxCostUsd],
    ["--geocode-limit", opts.geocodeLimit],
  ] as const) {
    if (number !== undefined && (!Number.isFinite(number) || number < 0)) {
      throw new Error(`Invalid ${name}: ${number}`);
    }
  }
  if (
    opts.limit !== undefined &&
    (!Number.isSafeInteger(opts.limit) || opts.limit < 1)
  )
    throw new Error("--limit must be a positive integer");
  if (opts.record && opts.limit === undefined) opts.limit = 1;
  if (opts.consolidate && (opts.limit !== undefined || opts.record))
    throw new Error("Consolidation is global; use a separate unlimited run");
  if (
    opts.reprocess &&
    !["extract", "normalize", "all"].includes(opts.reprocess)
  )
    throw new Error("Only extract/normalize/all support forced reprocessing");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  try {
    await runOrchestration(db, opts);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  console.error("Ingest run failed:", error);
  process.exit(1);
});
