import { getDb } from "../../lib/db/postgres.js";
import { getInventory } from "../../sql/ingestion-inventory.js";
import { buildImportQueue } from "../../lib/ingestion/queue.js";
import { inspectControl } from "./control.js";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--json") || args.length > 1)
  throw new Error(
    "Usage: ingest:queue [--json]. Refresh capture metadata with ingest:inventory --refresh first.",
  );
const db = getDb();
try {
  const inventory = await getInventory(db);
  const control = await inspectControl(db);
  const queue = buildImportQueue(inventory, control);
  if (args.includes("--json")) console.log(JSON.stringify(queue, null, 2));
  else {
    console.log(
      JSON.stringify(
        {
          inspected_at: queue.inspected_at,
          admission: queue.admission,
          counts: queue.counts,
          next: queue.next,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await db.end();
}
