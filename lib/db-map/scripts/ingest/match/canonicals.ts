import type { PoolClient } from "pg";

export async function collapseDuplicateCanonicals(
  client: PoolClient,
  targetId: string,
  duplicateIds: string[],
  consolidationDecisionId?: string | null,
): Promise<void> {
  if (duplicateIds.length === 0) return;
  await client.query(
    `UPDATE research_pois SET canonical_poi_id = $1 WHERE canonical_poi_id = ANY($2)`,
    [targetId, duplicateIds],
  );
  await client.query(
    `UPDATE research_canonical_memberships
     SET canonical_poi_id = $1
     WHERE canonical_poi_id = ANY($2) AND active`,
    [targetId, duplicateIds],
  );
  await client.query(
    `INSERT INTO canonical_poi_redirects (from_poi_id, to_poi_id, reason, consolidation_decision_id)
     SELECT duplicate_id, $1, 'canonical_merge', $3
     FROM unnest($2::uuid[]) AS duplicate_id
     ON CONFLICT (from_poi_id) DO UPDATE SET
       to_poi_id = EXCLUDED.to_poi_id,
       reason = EXCLUDED.reason,
       consolidation_decision_id = COALESCE(EXCLUDED.consolidation_decision_id, canonical_poi_redirects.consolidation_decision_id)`,
    [targetId, duplicateIds, consolidationDecisionId ?? null],
  );
  await client.query(
    `UPDATE canonical_pois SET status = 'hidden', updated_at = now() WHERE id = ANY($1)`,
    [duplicateIds],
  );
}
