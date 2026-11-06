/**
 * Review flags: filterable markers on canonical POIs for content that still needs
 * troubleshooting. They never block publication; the map shows flagged POIs and the API can
 * filter by flag (`/api/pois?review=<flag>`).
 *
 * - `general_location`: only a country/region/city-level location is known
 *   (`attributes.location_specificity = 'general'`).
 * - `source_needs_review`: a member's active observation came from a capture whose inventory
 *   disposition is still `needs_review` (its category or import decision is unconfirmed).
 * - `missing_address`: no active member has a source street address (an address filled in by
 *   reverse geocoding does not count). The POI is still mapped from its coordinates or locality.
 *
 * Add a flag by adding one entry to REVIEW_FLAG_RULES (an SQL predicate over canonical `p`).
 */
import type { Pool, PoolClient } from "pg";
import { CANONICAL_WRITER_LOCK } from "../lib/ingestion/locks.js";

export const REVIEW_FLAG_RULES = {
  general_location: `p.attributes->>'location_specificity' = 'general'`,
  // The capture the member's active observation currently points to (observations are reused
  // across identical captures, which update their source_file_version_id).
  source_needs_review: `EXISTS (
    SELECT 1 FROM research_canonical_memberships m
    JOIN research_pois rp ON rp.id = m.research_poi_id
    JOIN research_poi_observations o ON o.id = rp.active_observation_id
    JOIN research_source_file_versions v ON v.id = o.source_file_version_id
    JOIN research_source_files f ON f.id = v.source_file_id
    JOIN research_ingest_inventory i ON i.logical_path = f.logical_path
    WHERE m.canonical_poi_id = p.id AND m.active AND i.disposition = 'needs_review')`,
  missing_address: `NOT EXISTS (
    SELECT 1 FROM research_canonical_memberships m
    JOIN research_pois rp ON rp.id = m.research_poi_id
    WHERE m.canonical_poi_id = p.id AND m.active AND btrim(rp.address) <> ''
      AND rp.attributes->'location_enrichment'->'provenance'->>'address'
        IS DISTINCT FROM 'reverse_geocode')`,
} as const;

export type ReviewFlag = keyof typeof REVIEW_FLAG_RULES;
export const REVIEW_FLAGS = Object.keys(REVIEW_FLAG_RULES) as ReviewFlag[];

export function isReviewFlag(value: unknown): value is ReviewFlag {
  return typeof value === "string" && (REVIEW_FLAGS as string[]).includes(value);
}

const flagsSql = `ARRAY(SELECT flag FROM (VALUES ${REVIEW_FLAGS.map(
  (flag) => `('${flag}', ${REVIEW_FLAG_RULES[flag]})`,
).join(", ")}) AS r(flag, hit) WHERE hit ORDER BY flag)`;

/**
 * Recompute flags for the given canonicals (all when `ids` is null). Returns rows changed.
 * Callers outside a canonical rebuild should use `refreshAllReviewFlags`, which serializes with
 * rebuilds.
 */
export async function refreshReviewFlags(
  db: Pick<Pool | PoolClient, "query">,
  ids: string[] | null,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE canonical_pois cp SET review_flags = f.flags
     FROM (SELECT p.id, ${flagsSql} AS flags FROM canonical_pois p
           WHERE $1::uuid[] IS NULL OR p.id = ANY($1::uuid[])) f
     WHERE f.id = cp.id AND cp.review_flags IS DISTINCT FROM f.flags`,
    [ids],
  );
  return rowCount ?? 0;
}

/**
 * Recompute every POI's flags under the canonical writer lock, so a concurrent rebuild (which
 * refreshes its POI's flags while holding that lock) is never overwritten by an older snapshot.
 */
export async function refreshAllReviewFlags(db: Pool): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [CANONICAL_WRITER_LOCK]);
    // READ COMMITTED: this statement's snapshot is taken after the lock is held.
    const changed = await refreshReviewFlags(client, null);
    await client.query("COMMIT");
    return changed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Refresh the flags of every canonical linked to a run's records. A reused observation can
 * switch captures (and so `source_needs_review`) without any rebuild, so each run ends with
 * this, under the canonical writer lock like a rebuild.
 */
export async function refreshRunReviewFlags(db: Pool, runId: string): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [CANONICAL_WRITER_LOCK]);
    const { rows } = await client.query(
      `SELECT DISTINCT m.canonical_poi_id AS id FROM research_ingest_run_items i
       JOIN research_canonical_memberships m ON m.research_poi_id = i.research_poi_id AND m.active
       WHERE i.run_id = $1`,
      [runId],
    );
    const changed = rows.length ? await refreshReviewFlags(client, rows.map((r) => r.id)) : 0;
    await client.query("COMMIT");
    return changed;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Published POIs per flag. */
export async function reviewFlagCounts(db: Pick<Pool, "query">) {
  const { rows } = await db.query(
    `SELECT flag, count(*)::int AS pois FROM canonical_pois, unnest(review_flags) flag
     WHERE status='published' GROUP BY flag ORDER BY flag`,
  );
  return Object.fromEntries(
    REVIEW_FLAGS.map((flag) => [flag, rows.find((r) => r.flag === flag)?.pois ?? 0]),
  ) as Record<ReviewFlag, number>;
}
