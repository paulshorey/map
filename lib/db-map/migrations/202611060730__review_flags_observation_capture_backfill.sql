-- Re-backfill review flags reading each member's capture from its active observation's
-- source_file_version_id (observations are reused across identical captures), matching
-- sql/review-flags.ts.
UPDATE canonical_pois p SET review_flags = ARRAY(
  SELECT flag FROM (VALUES
    ('general_location', p.attributes->>'location_specificity' = 'general'),
    ('source_needs_review', EXISTS (
      SELECT 1 FROM research_canonical_memberships m
      JOIN research_pois rp ON rp.id = m.research_poi_id
      JOIN research_poi_observations o ON o.id = rp.active_observation_id
      JOIN research_source_file_versions v ON v.id = o.source_file_version_id
      JOIN research_source_files f ON f.id = v.source_file_id
      JOIN research_ingest_inventory i ON i.logical_path = f.logical_path
      WHERE m.canonical_poi_id = p.id AND m.active AND i.disposition = 'needs_review'))
  ) AS r(flag, hit) WHERE hit ORDER BY flag);
