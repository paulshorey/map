-- source_needs_review looks up a member's capture by research POI; without this index every
-- canonical rebuild would scan research_ingest_run_records.
CREATE INDEX research_ingest_run_records_research_poi_idx
  ON research_ingest_run_records (research_poi_id) WHERE research_poi_id IS NOT NULL;

-- Backfill the derived flags of POIs that existed before the column (same rules as
-- sql/review-flags.ts at this version).
UPDATE canonical_pois p SET review_flags = ARRAY(
  SELECT flag FROM (VALUES
    ('general_location', p.attributes->>'location_specificity' = 'general'),
    ('source_needs_review', EXISTS (
      SELECT 1 FROM research_canonical_memberships m
      JOIN research_ingest_run_records rr ON rr.research_poi_id = m.research_poi_id
      JOIN research_source_file_versions v ON v.id = rr.source_file_version_id
      JOIN research_source_files f ON f.id = v.source_file_id
      JOIN research_ingest_inventory i ON i.logical_path = f.logical_path
      WHERE m.canonical_poi_id = p.id AND m.active AND i.disposition = 'needs_review'))
  ) AS r(flag, hit) WHERE hit ORDER BY flag);
