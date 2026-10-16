import { getDb } from "../../lib/db/postgres.js";
import { auditLocations } from "../../sql/ingestion-location.js";
if (process.argv.slice(2).some((a) => a !== "--json"))
  throw new Error("Usage: ingest:location-audit [--json] (read only)");
const db = getDb();
try {
  console.log(JSON.stringify(await auditLocations(db), null, 2));
} finally {
  await db.end();
}
