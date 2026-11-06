/**
 * Review flags: filterable markers on canonical POIs for content that still needs
 * troubleshooting. They never block publication; the map shows flagged POIs and the API can
 * filter by flag (`/api/pois?review=<flag>`).
 *
 * - `general_location`: only a country/region/city-level location is known
 *   (`attributes.location_specificity = 'general'`).
 * - `source_needs_review`: a member came from a capture whose inventory disposition is still
 *   `needs_review` (its category or import decision is unconfirmed).
 *
 * Add a flag by adding one entry to REVIEW_FLAG_RULES (an SQL predicate over canonical `p`).
 */
import type { Pool, PoolClient } from "pg";

export const REVIEW_FLAG_RULES = {
  general_location: `p.attributes->>'location_specificity' = 'general'`,
  source_needs_review: `EXISTS (
    SELECT 1 FROM research_canonical_memberships m
    JOIN research_ingest_run_records rr ON rr.research_poi_id = m.research_poi_id
    JOIN research_source_file_versions v ON v.id = rr.source_file_version_id
    JOIN research_source_files f ON f.id = v.source_file_id
    JOIN research_ingest_inventory i ON i.logical_path = f.logical_path
    WHERE m.canonical_poi_id = p.id AND m.active AND i.disposition = 'needs_review')`,
} as const;

export type ReviewFlag = keyof typeof REVIEW_FLAG_RULES;
export const REVIEW_FLAGS = Object.keys(REVIEW_FLAG_RULES) as ReviewFlag[];

export function isReviewFlag(value: unknown): value is ReviewFlag {
  return typeof value === "string" && (REVIEW_FLAGS as string[]).includes(value);
}

const flagsSql = `ARRAY(SELECT flag FROM (VALUES ${REVIEW_FLAGS.map(
  (flag) => `('${flag}', ${REVIEW_FLAG_RULES[flag]})`,
).join(", ")}) AS r(flag, hit) WHERE hit ORDER BY flag)`;

/** Recompute flags for the given canonicals (all when `ids` is null). Returns rows changed. */
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
