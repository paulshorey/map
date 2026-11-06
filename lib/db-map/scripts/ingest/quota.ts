/**
 * Daily geocoding quota (LocationIQ): requests used today (UTC), the local limit and the reset.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:quota [--json]
 *   pnpm --filter @lib/db-map ingest:quota --clear-rate-limit   # after a plan upgrade today
 *
 * The limit is LOCATIONIQ_DAILY_LIMIT (default 5000, the free plan; 0 disables the local limit).
 */
import { pathToFileURL } from "node:url";
import { getDb } from "../../lib/db/postgres.js";
import { clearProviderRateLimit, providerUsageToday } from "./providers/quota.js";

async function main() {
  const args = process.argv.slice(2);
  const db = getDb();
  try {
    if (args.includes("--clear-rate-limit")) await clearProviderRateLimit(db);
    const usage = await providerUsageToday(db);
    if (args.includes("--json")) {
      console.log(JSON.stringify(usage, null, 2));
      return;
    }
    console.log(
      `LocationIQ ${usage.day} (UTC): ${usage.requests} requests` +
        (usage.limit ? ` of ${usage.limit}, ${usage.remaining} left` : " (no local limit)") +
        (usage.rate_limited_at ? `; provider answered "Rate Limited Day" at ${usage.rate_limited_at}` : "") +
        `. Resets at ${usage.resets_at}.`,
    );
    if (usage.exhausted)
      console.log("Geocoding is paused for today: runs stop as waiting_budget and resume after the reset.");
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
