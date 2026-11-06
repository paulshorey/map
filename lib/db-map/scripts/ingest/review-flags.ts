/**
 * Review flags on canonical POIs (see sql/review-flags.ts).
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:review-flags            # published POIs per flag
 *   pnpm --filter @lib/db-map ingest:review-flags --refresh  # recompute every POI's flags
 *     (refuses while ingestion is active: rebuilds refresh their own POIs meanwhile)
 */
import { pathToFileURL } from "node:url";
import { getDb } from "../../lib/db/postgres.js";
import { refreshAllReviewFlags, reviewFlagCounts } from "../../sql/review-flags.js";
import { inspectControl } from "./control.js";

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  let refreshed: number | null = null;
  const db = getDb();
  try {
    if (args.includes("--refresh")) {
      // A global rewrite must not race canonical rebuilds, which refresh their own POI's flags.
      const control = await inspectControl(db);
      // This command's own process (and its tsx launcher) is an ingest script too.
      const own = new Set([process.pid, process.ppid]);
      const others = control.local_script_processes.filter((p) => !own.has(p.pid));
      const active =
        control.workers.some((w) => w.status === "running") ||
        control.source_locks.length > 0 ||
        control.admitted_workers.length > 0 ||
        others.length > 0 ||
        !!control.process_scan_error;
      if (active)
        throw new Error(
          "Ingestion is active (workers, source locks or scripts); refresh after it is quiescent " +
            "(see ingest:control list --json). Rebuilds keep their own POIs' flags current meanwhile.",
        );
      refreshed = await refreshAllReviewFlags(db);
      if (!json) console.log(`Refreshed ${refreshed} POI(s).`);
    }
    const counts = await reviewFlagCounts(db);
    if (json) console.log(JSON.stringify({ refreshed, counts }, null, 2));
    else console.table(counts);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
