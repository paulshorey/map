import type { Pool } from "pg";

export async function traceResearchRecord(db: Pool, source: string, record: string): Promise<unknown> {
  const { rows } = await db.query(
    `SELECT jsonb_build_object(
       'research', to_jsonb(rp),
       'source', to_jsonb(rs),
       'observations', COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.last_seen_at DESC) FROM research_poi_observations o WHERE o.research_poi_id=rp.id), '[]'::jsonb),
       'normalizations', COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at DESC) FROM research_poi_normalizations n WHERE n.research_poi_id=rp.id), '[]'::jsonb),
       'geocodes', COALESCE((SELECT jsonb_agg(to_jsonb(g) ORDER BY g.created_at DESC) FROM research_poi_geocodes g JOIN research_poi_normalizations n ON n.id=g.normalization_id WHERE n.research_poi_id=rp.id), '[]'::jsonb),
       'embeddings', COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.created_at DESC) FROM research_poi_embeddings e JOIN research_poi_normalizations n ON n.id=e.normalization_id WHERE n.research_poi_id=rp.id), '[]'::jsonb),
       'memberships', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.assigned_at DESC) FROM research_canonical_memberships m WHERE m.research_poi_id=rp.id), '[]'::jsonb),
       'run_records', COALESCE((SELECT jsonb_agg(to_jsonb(rr) ORDER BY rr.source_ordinal) FROM research_ingest_run_records rr WHERE rr.research_poi_id=rp.id OR (rr.source_record_id=rp.source_record_id AND rr.source_file_version_id IN (SELECT id FROM research_source_file_versions WHERE source_file_id IN (SELECT id FROM research_source_files WHERE source_id=rp.source_id))), '[]'::jsonb)
     ) AS trace
     FROM research_pois rp JOIN research_sources rs ON rs.id=rp.source_id
     WHERE rs.slug=$1 AND rp.source_record_id=$2`,
    [source, record],
  );
  return rows[0]?.trace ?? null;
}

export async function traceCanonical(db: Pool, canonicalId: string): Promise<unknown> {
  const { rows } = await db.query(
    `SELECT jsonb_build_object(
       'canonical', to_jsonb(cp),
       'active_build', (SELECT to_jsonb(b) FROM canonical_poi_builds b WHERE b.id=cp.active_build_id),
       'build_inputs', COALESCE((SELECT jsonb_agg(to_jsonb(i)) FROM canonical_poi_build_inputs i WHERE i.build_id=cp.active_build_id), '[]'::jsonb),
       'memberships', COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.assigned_at DESC) FROM research_canonical_memberships m WHERE m.canonical_poi_id=cp.id), '[]'::jsonb),
       'redirects', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM canonical_poi_redirects r WHERE r.from_poi_id=cp.id OR r.to_poi_id=cp.id), '[]'::jsonb)
     ) AS trace FROM canonical_pois cp WHERE cp.id=$1`,
    [canonicalId],
  );
  return rows[0]?.trace ?? null;
}
