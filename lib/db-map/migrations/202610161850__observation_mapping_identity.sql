-- Raw bytes alone cannot identify an observation after an extractor mapping changes.
-- Keep the original raw SHA and immutable captured snapshots; PostgreSQL computes a
-- stable mapping identity from JSONB (key ordering does not cause spurious refreshes).
ALTER TABLE research_poi_observations
  ADD COLUMN capture_hash text GENERATED ALWAYS AS
    (md5(captured::text || ':' || COALESCE(source_is_poi_hint::text, 'null'))) STORED;

ALTER TABLE research_poi_observations
  DROP CONSTRAINT research_poi_observations_research_poi_id_raw_content_hash_key;

ALTER TABLE research_poi_observations
  ADD CONSTRAINT research_poi_observations_input_key
    UNIQUE (research_poi_id, raw_content_hash, capture_hash);
