/**
 * File-first POI ingestion orchestrator.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:run <data/poi/...json|jsonl|csv> --category <slug> [options]
 *
 * --category is required on every run. Category is never inferred from path or raw data.
 */
import { getDb } from "../../lib/db/postgres.js";
import { pathToFileURL } from "node:url";
import { assertValidCategory, listCategorySlugs } from "./taxonomy.js";
import {
  runOrchestration,
  type IngestStage,
  type OrchestratorOptions,
} from "./orchestrator.js";
import { holdSystemAwake } from "./sleep-inhibitor.js";
import { providerUsageToday, useProviderQuotaLedger } from "./providers/quota.js";
import {
  IMPORT_QUEUE_ENV,
  IMPORT_QUEUE_LOCK,
  INGEST_LOCK_NAMESPACE,
} from "../../lib/ingestion/locks.js";

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
    "Usage: ingest:run <data/poi/...json|jsonl|csv> --category <slug> [options]",
  );
  console.error(`Known categories: ${listCategorySlugs().join(", ")}`);
  process.exit(1);
}

export function parseArgs(argv: string[]): OrchestratorOptions {
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
    else if (arg === "--llm-concurrency") opts.llmConcurrency = Number(value());
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
    } else if (arg === "--unlimited") opts.unlimited = true;
    else if (arg === "--max-llm-requests")
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
        "--resume preserves scope/options; only --stop-after, --dry-run, --unlimited and optional provider limits may be overridden",
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
    opts.unlimited &&
    [opts.maxLlmRequests, opts.maxCostUsd, opts.geocodeLimit].some(
      (value) => value !== undefined,
    )
  )
    throw new Error("--unlimited cannot be combined with provider limits");
  for (const [name, number] of [
    ["--max-llm-requests", opts.maxLlmRequests],
    ["--geocode-limit", opts.geocodeLimit],
  ] as const) {
    if (number !== undefined && !Number.isSafeInteger(number))
      throw new Error(`${name} must be a nonnegative integer`);
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
  if (
    opts.llmConcurrency !== undefined &&
    (!Number.isSafeInteger(opts.llmConcurrency) ||
      opts.llmConcurrency < 1 ||
      opts.llmConcurrency > 16)
  )
    throw new Error("--llm-concurrency must be 1..16");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const releaseAwake = opts.dryRun ? () => {} : await holdSystemAwake();
  try {
    process.env.PG_POOL_MAX ||= "16";
    const db = getDb();
    let fence: import("pg").PoolClient | null = null;
    try {
      useProviderQuotaLedger(db);
      // One full import at a time: a plain import holds the queue lock in shared mode for its
      // whole run, the queue worker holds it exclusively, so admission is atomic. Imports the
      // queue launches itself carry IMPORT_QUEUE_ENV and skip it.
      if (!opts.dryRun && !process.env[IMPORT_QUEUE_ENV]) {
        fence = await db.connect();
        const { rows } = await fence.query("SELECT pg_try_advisory_lock_shared($1, $2) AS ok", [
          INGEST_LOCK_NAMESPACE,
          IMPORT_QUEUE_LOCK,
        ]);
        if (!rows[0]?.ok)
          throw new Error(
            "An import queue is running (ingest:import-queue status); stop it or add this file to a queue",
          );
      }
      if (!opts.dryRun) {
        const usage = await providerUsageToday(db);
        console.log(
          `LocationIQ today: ${usage.requests}${usage.limit ? `/${usage.limit}` : ""} requests` +
            `${usage.exhausted ? ` — daily quota reached; geocoding will pause the run until ${usage.resets_at}` : ""}`,
        );
      }
      await runOrchestration(db, opts);
    } finally {
      if (fence) {
        await fence
          .query("SELECT pg_advisory_unlock_shared($1, $2)", [INGEST_LOCK_NAMESPACE, IMPORT_QUEUE_LOCK])
          .catch(() => undefined);
        fence.release();
      }
      await db.end();
    }
  } finally {
    releaseAwake();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error("Ingest run failed:", error);
    process.exit(1);
  });
}
