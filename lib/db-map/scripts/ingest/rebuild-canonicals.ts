/**
 * Rebuild the matching layer after a matcher or canonical-builder change.
 *
 * Memberships and research-derived canonical POIs are derived wholly from stored research
 * records (their normalization, coordinates and embedding). When only the matcher or the
 * canonical builder changed, this drops that layer and matches every record again with the
 * current logic. No capture is re-read and no record is normalized, geocoded or embedded
 * again; the only provider calls are the matcher's own (same-place verdicts, description
 * merges).
 *
 * What it keeps: manually curated POIs (`origin = 'manual'`), manual match overrides, and
 * earlier match decisions as history. What it does not keep: canonical IDs and the
 * redirects between them, as after a purge. While it runs, the map shows only the POIs
 * already rebuilt.
 *
 * It refuses while any record itself is outdated (those sources are re-ingested first) and
 * requires owned, quiescent maintenance, like `ingest:purge`. Keep maintenance on until it
 * finishes. A failed model call stops it; nothing is published from a fallback. Continue a
 * stopped rebuild with `--continue`, which matches the remaining records without resetting
 * anything. Afterwards each file needs its verification run again: the inventory lists it
 * as `ready_to_verify`.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:rebuild-canonicals --dry-run
 *   pnpm --filter @lib/db-map ingest:rebuild-canonicals --maintenance-token <owned-token> [--consolidate] [--no-llm]
 *   pnpm --filter @lib/db-map ingest:rebuild-canonicals --maintenance-token <owned-token> --continue [--consolidate] [--no-llm]
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
  /** Research-derived canonicals that will be removed; manual ones are kept. */
  canonicals: number;
  /** Records not linked to any canonical: what `--continue` would match. */
  unlinked: number;
  /** Pair verdicts from an earlier global consolidation: pass `--consolidate` to redo it. */
  consolidated: number;
}

export async function rebuildPlan(db: Pool): Promise<RebuildPlan> {
  const rows = await stalenessBySource(db);
  const counts = (
    await db.query(
      `SELECT (SELECT count(*) FROM research_pois WHERE canonical_poi_id IS NOT NULL)::int AS linked,
        (SELECT count(*) FROM canonical_pois WHERE origin <> 'manual')::int AS canonicals,
        (SELECT count(*) FROM research_pois WHERE canonical_poi_id IS NULL AND retired_at IS NULL AND is_poi
          AND lat IS NOT NULL AND lng IS NOT NULL AND name_normalized IS NOT NULL AND category_slugs IS NOT NULL)::int AS unlinked,
        (SELECT count(*) FROM research_consolidation_decisions)::int AS consolidated`,
    )
  ).rows[0];
  return {
    outdated: rows.reduce((sum, row) => sum + row.rebuild, 0),
    linked: counts.linked,
    canonicals: counts.canonicals,
    unlinked: counts.unlinked,
    consolidated: counts.consolidated,
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
  opts: {
    maintenanceToken: string;
    noLlm: boolean;
    /** Match the records a stopped rebuild left unlinked; reset nothing. */
    resume?: boolean;
    /** Run the global consolidation sweep after matching. */
    consolidate?: boolean;
  },
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
        continued: !!opts.resume,
        consolidate: !!opts.consolidate,
      }),
    ],
  );
  const stats = await runMatch(
    db,
    {
      limit: undefined,
      dryRun: false,
      noLlm: opts.noLlm,
      // A failed model call must stop the rebuild, never quietly decide "different place"
      // or publish a fallback description as a current build.
      strictLlm: true,
      recluster: !opts.resume,
      keepDecisions: true,
      gcOrphans: false,
      consolidate: !!opts.consolidate,
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
          `A rebuild removes ${plan.canonicals} research-derived canonicals (manual POIs are kept) ` +
          `and matches ${plan.linked + plan.unlinked} records again; --continue would match ${plan.unlinked}.` +
          (plan.consolidated
            ? ` This database holds ${plan.consolidated} consolidation verdicts: pass --consolidate to redo the global sweep.`
            : ""),
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
      resume: args.includes("--continue"),
      consolidate: args.includes("--consolidate"),
    });
    console.log(
      `Rebuilt canonicals: ${args.includes("--continue") ? "continued" : `removed ${plan.canonicals}`}, matched ${stats.processed} records ` +
        `(created ${stats.created}, merged ${stats.merged}, model verdicts ${stats.llm}, consolidated ${stats.consolidated}). ` +
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
