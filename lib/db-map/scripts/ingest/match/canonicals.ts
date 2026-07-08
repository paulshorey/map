import type { PoolClient } from "pg";

export async function collapseDuplicateCanonicals(
  client: PoolClient,
  targetId: string,
  duplicateIds: string[],
): Promise<void> {
  if (duplicateIds.length === 0) return;
  await client.query(
    `UPDATE research_pois SET canonical_poi_id = $1 WHERE canonical_poi_id = ANY($2)`,
    [targetId, duplicateIds],
  );
  await client.query(
    `UPDATE canonical_pois SET status = 'hidden', updated_at = now() WHERE id = ANY($1)`,
    [duplicateIds],
  );
}
