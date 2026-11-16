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
import { dedicatedClient, getDb } from "../../lib/db/postgres.js";
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
  /**
   * Evidence that canonicals were merged after matching: pair verdicts from a global
   * consolidation, or redirects (rule-based consolidation merges write only those).
   * Pass `--consolidate` to redo the sweep.
   */
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
        ((SELECT count(*) FROM research_consolidation_decisions)
          + (SELECT count(*) FROM canonical_poi_redirects))::int AS consolidated`,
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

/**
 * Take the exclusive admission lock (managed workers hold it shared) and check that the
 * caller owns the maintenance gate. The returned release must be called when the rebuild
 * ends: holding the lock on its own session keeps new workers out for the whole run, even
 * if someone exits maintenance meanwhile.
 */
async function holdOwnedMaintenance(db: Pool, token: string) {
  // Its own connection, outside the pool: a small pool cannot starve the rebuild of the
  // connections matching needs while this one sits holding the lock.
  const lock = await dedicatedClient("ingest-rebuild-canonicals");
  const refuse = () =>
    new Error("Owned, quiescent maintenance is required to rebuild canonicals");
  try {
    const drain = (
      await lock.query("SELECT pg_try_advisory_lock(91832,1) AS acquired")
    ).rows[0];
    if (!drain.acquired) throw refuse();
    const gate = (
      await db.query("SELECT * FROM research_ingest_control WHERE singleton")
    ).rows[0];
    if (!gate?.maintenance || gate.maintenance_token !== token) throw refuse();
  } catch (error) {
    // Closing the connection releases its session lock.
    await lock.end().catch(() => undefined);
    throw error;
  }
  return () => lock.end();
}

/** Flags the command accepts; anything else is refused rather than ignored. */
const FLAGS = new Set(["--dry-run", "--continue", "--consolidate", "--no-llm"]);

/** A mistyped `--continue` must never fall through to a full, destructive rebuild. */
export function parseRebuildArgs(argv: string[]) {
  const opts = {
    dryRun: false,
    resume: false,
    consolidate: false,
    noLlm: false,
    token: undefined as string | undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--maintenance-token") {
      const value = argv[++i];
      if (!value || value.startsWith("--"))
        throw new Error("--maintenance-token needs a value");
      opts.token = value;
    } else if (!FLAGS.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    else if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--continue") opts.resume = true;
    else if (arg === "--consolidate") opts.consolidate = true;
    else opts.noLlm = true;
  }
  return opts;
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
  const release = await holdOwnedMaintenance(db, opts.maintenanceToken);
  try {
    return await rebuildUnderLock(db, opts);
  } finally {
    await release();
  }
}

async function rebuildUnderLock(
  db: Pool,
  opts: { noLlm: boolean; resume?: boolean; consolidate?: boolean },
) {
  const plan = await rebuildPlan(db);
  // Continuing keeps what is already linked, so all of it must be from the current logic.
  if (opts.resume && plan.outdated)
    throw Object.assign(
      new Error(
        `${plan.outdated} linked records are from an older matcher or builder: --continue would keep them. ` +
          "Run a full rebuild (without --continue) instead.",
      ),
      { code: "outdated_canonicals" },
    );
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
  const args = parseRebuildArgs(process.argv.slice(2));
  const db = getDb();
  try {
    if (args.dryRun) {
      await assertRecordsCurrent(db);
      const plan = await rebuildPlan(db);
      console.log(
        `Dry run: ${plan.outdated} linked records are from an older matcher or builder. ` +
          `A rebuild removes ${plan.canonicals} research-derived canonicals (manual POIs are kept) ` +
          `and matches ${plan.linked + plan.unlinked} records again; --continue would match ${plan.unlinked}.` +
          (plan.consolidated
            ? ` This database holds ${plan.consolidated} consolidation verdicts or merge redirects: pass --consolidate to redo the global sweep.`
            : " No sign of an earlier consolidation; pass --consolidate anyway if you ran one."),
      );
      return;
    }
    const token = args.token;
    if (!token)
      throw new Error(
        "Refusing: pass --maintenance-token <owned-token> (try --dry-run first)",
      );
    const { plan, stats } = await rebuildCanonicals(db, {
      maintenanceToken: token,
      noLlm: args.noLlm,
      resume: args.resume,
      consolidate: args.consolidate,
    });
    console.log(
      `Rebuilt canonicals: ${args.resume ? "continued" : `removed ${plan.canonicals}`}, matched ${stats.processed} records ` +
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
