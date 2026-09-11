import { getDb } from "../../lib/db/postgres.js";
import { traceCanonical, traceResearchRecord } from "../../sql/lineage.js";

function value(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const canonical = value(args, "--canonical");
  const source = value(args, "--source");
  const record = value(args, "--record");
  if (!canonical && (!source || !record)) throw new Error("Usage: ingest:trace --canonical <uuid> | --source <slug> --record <id> [--json]");
  const db = getDb();
  try {
    const trace = canonical ? await traceCanonical(db, canonical) : await traceResearchRecord(db, source!, record!);
    if (!trace) throw new Error("No matching lineage found");
    console.log(JSON.stringify(trace, null, 2));
  } finally { await db.end(); }
}
main().catch((error) => { console.error("Ingest trace failed:", error); process.exit(1); });
