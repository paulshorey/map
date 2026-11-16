/**
 * Rebuild the matching layer after a matcher or canonical-builder change.
 *
 * Memberships, match decisions and canonical POIs are derived wholly from stored research
 * records (their normalization, coordinates and embedding). When only the matcher or the
 * canonical builder changed, this drops that layer and matches every record again with the
 * current logic. No capture is re-read and no record is normalized, geocoded or embedded
 * again; the only provider calls are the matcher's own (same-place verdicts, description
 * merges). Canonical IDs change, as they do after a purge.
 *
 * It refuses while any record itself is outdated (those sources are re-ingested first) and
 * requires owned, quiescent maintenance, like `ingest:purge`. Keep maintenance on until it
 * finishes. A stopped or failed rebuild is continued with `ingest:match` (unlinked records
 * are matched; nothing is reset again). Afterwards each file needs its verification run
 * again: the inventory lists it as `ready_to_verify`.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:rebuild-canonicals --dry-run
 *   pnpm --filter @lib/db-map ingest:rebuild-canonicals --maintenance-token <owned-token> [--no-llm]
 */
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { ingestConfig } from "./config.js";
import { runMatch } from "./match.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import { assertRecordsCurrent, stalenessBySource } from "./staleness.js";

export interface RebuildPlan {
  /** Linked records whose membership or canonical build is from older logic. */
  outdated: number;
  /** Records that will be matched again: every one currently linked to a canonical. */
  linked: number;
  canonicals: number;
}

export async function rebuildPlan(db: Pool): Promise<RebuildPlan> {
  const rows = await stalenessBySource(db);
  const counts = (
    await db.query(
      `SELECT (SELECT count(*) FROM research_pois WHERE canonical_poi_id IS NOT NULL)::int AS linked,
        (SELECT count(*) FROM canonical_pois)::int AS canonicals`,
    )
  ).rows[0];
  return {
    outdated: rows.reduce((sum, row) => sum + row.rebuild, 0),
    linked: counts.linked,
    canonicals: counts.canonicals,
  };
}

/** Fails unless the caller owns the maintenance gate and no worker is admitted. */
async function assertOwnedMaintenance(db: Pool, token: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const gate = (
      await client.query("SELECT * FROM research_ingest_control WHERE singleton")
    ).rows[0];
    const drain = (
      await client.query("SELECT pg_try_advisory_xact_lock(91832,1) AS acquired")
    ).rows[0];
    if (!gate?.maintenance || !drain.acquired || gate.maintenance_token !== token)
      throw new Error("Owned, quiescent maintenance is required to rebuild canonicals");
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

export async function rebuildCanonicals(
  db: Pool,
  opts: { maintenanceToken: string; noLlm: boolean },
) {
  await assertRecordsCurrent(db);
  await assertOwnedMaintenance(db, opts.maintenanceToken);
  const plan = await rebuildPlan(db);
  await db.query(
    `INSERT INTO research_ingest_control_events(action, actor, details)
     VALUES ('rebuild_canonicals', current_user, $1::jsonb)`,
    [
      JSON.stringify({
        reason: "Matcher or canonical builder changed; records are current",
        matcher: PIPELINE_VERSIONS.matcher,
        canonical_builder: PIPELINE_VERSIONS.canonicalBuilder,
        ...plan,
        no_llm: opts.noLlm,
      }),
    ],
  );
  const stats = await runMatch(
    db,
    {
      limit: undefined,
      dryRun: false,
      noLlm: opts.noLlm,
      // A failed model call must stop the rebuild, never quietly decide "different place".
      strictLlm: true,
      recluster: true,
      gcOrphans: false,
      consolidate: false,
      consolidateOnly: false,
      tHigh: ingestConfig.match.tHigh,
      tLow: ingestConfig.match.tLow,
    },
    { requested: false, count: 0 },
  );
  return { plan, stats };
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag: string) =>
    args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  const db = getDb();
  try {
    if (args.includes("--dry-run")) {
      await assertRecordsCurrent(db);
      const plan = await rebuildPlan(db);
      console.log(
        `Dry run: ${plan.outdated} linked records are from an older matcher or builder. ` +
          `A rebuild removes ${plan.canonicals} canonicals and matches ${plan.linked} records again.`,
      );
      return;
    }
    const token = value("--maintenance-token");
    if (!token)
      throw new Error(
        "Refusing: pass --maintenance-token <owned-token> (try --dry-run first)",
      );
    const { plan, stats } = await rebuildCanonicals(db, {
      maintenanceToken: token,
      noLlm: args.includes("--no-llm"),
    });
    console.log(
      `Rebuilt canonicals: removed ${plan.canonicals}, matched ${stats.processed} records ` +
        `(created ${stats.created}, merged ${stats.merged}, model verdicts ${stats.llm}). ` +
        "Verify each file again (the inventory lists it as ready_to_verify).",
    );
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
