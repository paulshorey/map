/**
 * Review flags on canonical POIs (see sql/review-flags.ts).
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:review-flags            # published POIs per flag
 *   pnpm --filter @lib/db-map ingest:review-flags --refresh  # recompute every POI's flags
 */
import { pathToFileURL } from "node:url";
import { getDb } from "../../lib/db/postgres.js";
import { refreshReviewFlags, reviewFlagCounts } from "../../sql/review-flags.js";

async function main() {
  const args = process.argv.slice(2);
  const db = getDb();
  try {
    if (args.includes("--refresh")) console.log(`Refreshed ${await refreshReviewFlags(db, null)} POI(s).`);
    const counts = await reviewFlagCounts(db);
    if (args.includes("--json")) console.log(JSON.stringify(counts, null, 2));
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
