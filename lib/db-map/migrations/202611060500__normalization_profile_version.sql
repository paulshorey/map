-- The normalization profile version of every normalization artifact, including deterministic
-- (--no-llm) ones that have no provider request. ingest:staleness compares it with the current
-- profiles; before this column only provider-backed artifacts carried a profile version (on
-- their request row), so deterministic artifacts were always reported current.
ALTER TABLE research_poi_normalizations ADD COLUMN profile_version text;

UPDATE research_poi_normalizations n
SET profile_version = q.profile_version
FROM research_normalization_requests q
WHERE q.id = n.request_id AND n.profile_version IS NULL;
