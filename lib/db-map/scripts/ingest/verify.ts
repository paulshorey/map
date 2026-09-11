import type { Pool } from "pg";
import { pathToFileURL } from "node:url";
import { getDb } from "../../lib/db/postgres.js";

export async function verifyLineage(db: Pool): Promise<number> {
  const checks: Array<[string, string]> = [
    ["membership cache", `SELECT count(*)::int AS count FROM research_pois rp WHERE COALESCE(rp.canonical_poi_id::text,'') <> COALESCE((SELECT m.canonical_poi_id::text FROM research_canonical_memberships m WHERE m.research_poi_id=rp.id AND m.active),'')`],
    ["visible canonical membership", `SELECT count(*)::int AS count FROM canonical_pois cp WHERE cp.origin='research' AND cp.status='published' AND NOT EXISTS (SELECT 1 FROM research_canonical_memberships m WHERE m.canonical_poi_id=cp.id AND m.active)`],
    ["active build inputs", `SELECT count(*)::int AS count FROM canonical_pois cp WHERE cp.origin='research' AND cp.status='published' AND cp.active_build_id IS NOT NULL AND (SELECT count(*) FROM canonical_poi_build_inputs i WHERE i.build_id=cp.active_build_id) <> (SELECT count(*) FROM research_canonical_memberships m WHERE m.canonical_poi_id=cp.id AND m.active)`],
    ["dangling active artifacts", `SELECT count(*)::int AS count FROM research_pois rp WHERE (rp.active_geocode_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_poi_geocodes g WHERE g.id=rp.active_geocode_id AND g.normalization_id=rp.active_normalization_id)) OR (rp.active_embedding_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM research_poi_embeddings e WHERE e.id=rp.active_embedding_id AND e.normalization_id=rp.active_normalization_id))`],
    ["redirect target", `SELECT count(*)::int AS count FROM canonical_poi_redirects r LEFT JOIN canonical_pois cp ON cp.id=r.to_poi_id WHERE cp.id IS NULL`],
  ];
  let failed = 0;
  for (const [name, sql] of checks) {
    const { rows } = await db.query<{ count: number }>(sql);
    const count = Number(rows[0]?.count ?? 0);
    console.log(`verify ${name}: ${count === 0 ? "ok" : `${count} violation(s)`}`);
    failed += count;
  }
  return failed;
}

async function main() {
  const db = getDb();
  try {
    if (await verifyLineage(db)) process.exitCode = 1;
  } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error("Ingest verify failed:", error); process.exit(1); });
}
