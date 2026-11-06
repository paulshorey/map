-- Re-backfill review flags with the active-observation rule (202611060710 joined every
-- historical run record of a member; source_needs_review must follow the capture of each
-- member's active observation, as sql/review-flags.ts does).
UPDATE canonical_pois p SET review_flags = ARRAY(
  SELECT flag FROM (VALUES
    ('general_location', p.attributes->>'location_specificity' = 'general'),
    ('source_needs_review', EXISTS (
      SELECT 1 FROM research_canonical_memberships m
      JOIN research_pois rp ON rp.id = m.research_poi_id
      JOIN research_ingest_run_records rr ON rr.research_poi_id = rp.id
        AND rr.observation_id = rp.active_observation_id
      JOIN research_source_file_versions v ON v.id = rr.source_file_version_id
      JOIN research_source_files f ON f.id = v.source_file_id
      JOIN research_ingest_inventory i ON i.logical_path = f.logical_path
      WHERE m.canonical_poi_id = p.id AND m.active AND i.disposition = 'needs_review'))
  ) AS r(flag, hit) WHERE hit ORDER BY flag);
