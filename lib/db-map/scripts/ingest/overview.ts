import { getDb } from "../../lib/db/postgres.js";
import { getOverview } from "../../sql/ingestion-overview.js";
export function parseOverviewArgs(args: string[]) {
  const opts: {
    run?: string;
    file?: string;
    detail?: boolean;
    limit?: number;
    offset?: number;
  } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--json") continue;
    if (["--limit", "--offset"].includes(arg!)) {
      const n = Number(args[++i]);
      if (
        !Number.isSafeInteger(n) ||
        n < 0 ||
        (arg === "--limit" && (n < 1 || n > 100))
      )
        throw new Error("Limit must be 1..100 and offset nonnegative");
      if (arg === "--limit") opts.limit = n;
      else opts.offset = n;
      continue;
    }
    if (arg === "--detail") {
      opts.detail = true;
      continue;
    }
    if (
      !["--run", "--file"].includes(arg!) ||
      !args[i + 1] ||
      args[i + 1]!.startsWith("--")
    )
      throw new Error(
        "Usage: ingest:overview [--run UUID|--file PATH] [--detail] [--json]",
      );
    if (arg === "--run") {
      opts.run = args[++i];
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(opts.run!))
        throw new Error("Run must be a UUID");
    } else opts.file = args[++i];
  }
  return opts;
}
const db = getDb();
try {
  const result = await getOverview(
    db,
    parseOverviewArgs(process.argv.slice(2)),
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.components.database.status === "unknown") process.exitCode = 2;
} finally {
  await db.end();
}
