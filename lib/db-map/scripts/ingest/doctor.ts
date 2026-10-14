import { getDb } from "../../lib/db/postgres.js";
import { getOverview } from "../../sql/ingestion-overview.js";
const args = process.argv.slice(2);
if (
  args[0] !== "--run" ||
  !args[1] ||
  !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args[1]) ||
  args.slice(2).some((a) => a !== "--json")
)
  throw new Error("Usage: ingest:doctor --run UUID [--json]");
const db = getDb();
try {
  const result = await getOverview(db, { run: args[1], detail: true });
  console.log(JSON.stringify(result, null, 2));
  if (result.components.database.status === "unknown") process.exitCode = 2;
} finally {
  await db.end();
}
