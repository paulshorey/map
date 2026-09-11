/**
 * Compatibility entry point for extraction diagnostics. It intentionally runs the
 * file-first orchestrator so standalone extraction creates the same file-version,
 * run, observation, and collision lineage as ingest:run.
 */
import { getDb } from "../../lib/db/postgres.js";
import { runOrchestration, type OrchestratorOptions } from "./orchestrator.js";
import { resolveSourceFile } from "./source-file.js";
import { assertValidCategory, listCategorySlugs } from "./taxonomy.js";

function usage(message: string): never {
  console.error(message);
  console.error("Usage: ingest:extract <source-slug> <file> --category <slug> [--limit N] [--dry-run]");
  console.error(`Known categories: ${listCategorySlugs().join(", ")}`);
  process.exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const source = positional[0];
  const file = positional[1];
  const categoryIndex = argv.indexOf("--category");
  const category = categoryIndex >= 0 ? argv[categoryIndex + 1] : undefined;
  if (!source || !file || !category) usage("Missing source, file, or category.");
  assertValidCategory(category);
  const limitIndex = argv.indexOf("--limit");
  const limit = limitIndex >= 0 ? Number(argv[limitIndex + 1]) : undefined;
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) usage("Invalid --limit.");
  const resolved = await resolveSourceFile(file, category);
  if (resolved.source.meta.slug !== source) {
    usage(`File resolves to source "${resolved.source.meta.slug}", not "${source}".`);
  }
  const opts: OrchestratorOptions = {
    file, category, limit, dryRun: argv.includes("--dry-run"), stopAfter: "extract",
    shadow: false, retryFailed: false, noLlm: true,
  };
  const db = getDb();
  try { await runOrchestration(db, opts); } finally { await db.end(); }
}
main().catch((error) => { console.error("Extract failed:", error); process.exit(1); });
