/**
 * File-first POI ingestion orchestrator.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:run <docs/poi/...json|jsonl|csv> --category <slug> [options]
 *
 * --category is required on every run and is never inferred from path or raw data. Repeat
 * --category to tag every record with multiple categories; the first is the primary category.
 */
import { getDb } from "../../lib/db/postgres.js";
import {
  assertValidCategory,
  listCategorySlugs,
} from "./taxonomy.js";
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
  "report",
]);

function stage(value: string, flag: string): IngestStage {
  if (!STAGES.has(value as IngestStage)) throw new Error(`Invalid ${flag}: ${value}`);
  return value as IngestStage;
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

function usageError(message: string): never {
  console.error(message);
  console.error(
    "Usage: ingest:run <docs/poi/...json|jsonl|csv> --category <slug> [--category <slug> ...] [options]",
  );
  console.error(`Known categories: ${listCategorySlugs().join(", ")}`);
  process.exit(1);
}

function parseArgs(argv: string[]): OrchestratorOptions {
  const file = argv[0];
  if (!file || file.startsWith("--")) {
    usageError("Missing <file>.");
  }
  const opts: OrchestratorOptions = {
    file,
    categories: [],
    dryRun: false,
    shadow: false,
    retryFailed: false,
    noLlm: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
      return next;
    };
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--shadow") opts.shadow = true;
    else if (arg === "--retry-failed") opts.retryFailed = true;
    else if (arg === "--no-llm") opts.noLlm = true;
    else if (arg === "--category") opts.categories.push(value());
    else if (arg === "--limit") opts.limit = Number(value());
    else if (arg === "--stop-after") opts.stopAfter = stage(value(), arg);
    else if (arg === "--from") opts.fromStage = stage(value(), arg);
    else if (arg === "--reprocess") {
      const selected = value();
      opts.reprocess = selected === "all" ? "all" : stage(selected, arg);
    } else if (arg === "--max-llm-requests") opts.maxLlmRequests = Number(value());
    else if (arg === "--max-cost-usd") opts.maxCostUsd = Number(value());
    else if (arg === "--geocode-limit") opts.geocodeLimit = Number(value());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (opts.categories.length === 0) {
    usageError("Missing required --category <slug> (repeat for multiple categories).");
  }
  try {
    for (const category of opts.categories) assertValidCategory(category);
  } catch (error) {
    usageError(error instanceof Error ? error.message : String(error));
  }
  opts.categories = dedupePreserveOrder(opts.categories);
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
