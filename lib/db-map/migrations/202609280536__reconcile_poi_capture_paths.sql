-- The repository move from docs/poi to data/poi did not change capture identity.
-- Keep original inventory/source-file IDs and their run/version lineage. A scan may
-- already have inserted duplicate data/poi inventory rows; merge those first.
CREATE TEMP TABLE poi_inventory_path_moves ON COMMIT DROP AS
SELECT old.id AS old_id,
  CASE
    WHEN old.logical_path LIKE 'docs/poi/%' THEN 'data/poi/' || substr(old.logical_path, 10)
    ELSE 'data/poi/' || substr(old.logical_path, 5)
  END AS new_path,
  fresh.id AS current_id
FROM research_ingest_inventory old
LEFT JOIN research_ingest_inventory fresh ON fresh.logical_path =
  CASE
    WHEN old.logical_path LIKE 'docs/poi/%' THEN 'data/poi/' || substr(old.logical_path, 10)
    ELSE 'data/poi/' || substr(old.logical_path, 5)
  END
WHERE old.logical_path LIKE 'docs/poi/%' OR old.logical_path LIKE 'poi/%';

CREATE TEMP TABLE poi_source_path_moves ON COMMIT DROP AS
SELECT f.id,
  CASE
    WHEN f.logical_path LIKE 'docs/poi/%' THEN 'data/poi/' || substr(f.logical_path, 10)
    ELSE 'data/poi/' || substr(f.logical_path, 5)
  END AS new_path
FROM research_source_files f
WHERE f.logical_path LIKE 'docs/poi/%' OR f.logical_path LIKE 'poi/%';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM poi_inventory_path_moves GROUP BY new_path HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Multiple legacy inventory paths map to one data/poi path';
  END IF;
  IF EXISTS (
    SELECT 1 FROM poi_source_path_moves GROUP BY new_path HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM poi_source_path_moves m
    JOIN research_source_files f ON f.logical_path = m.new_path AND f.id <> m.id
  ) THEN
    RAISE EXCEPTION 'Conflicting source-file identity at data/poi path';
  END IF;
  IF EXISTS (
    SELECT 1 FROM poi_inventory_path_moves m
    JOIN research_ingest_inventory old ON old.id = m.old_id
    JOIN research_ingest_inventory fresh ON fresh.id = m.current_id
    WHERE old.source_slug IS DISTINCT FROM fresh.source_slug
      OR old.category_slug IS DISTINCT FROM fresh.category_slug
      OR old.disposition IS DISTINCT FROM fresh.disposition
      OR old.notes IS DISTINCT FROM fresh.notes
      OR old.priority IS DISTINCT FROM fresh.priority
      OR old.format IS DISTINCT FROM fresh.format
      OR old.extractor_version IS DISTINCT FROM fresh.extractor_version
      OR (old.file_sha256 IS NOT NULL AND fresh.file_sha256 IS NOT NULL
          AND old.file_sha256 <> fresh.file_sha256)
  ) THEN
    RAISE EXCEPTION 'Legacy and current inventory rows disagree; reconcile operator decisions or capture content first';
  END IF;
  IF EXISTS (
    SELECT 1 FROM poi_inventory_path_moves m
    JOIN research_ingest_inventory_versions old ON old.inventory_id = m.old_id
    JOIN research_ingest_inventory_versions fresh
      ON fresh.inventory_id = m.current_id AND fresh.file_sha256 = old.file_sha256
    WHERE old.byte_size <> fresh.byte_size
  ) THEN
    RAISE EXCEPTION 'Matching inventory hashes have different byte sizes';
  END IF;
END $$;

INSERT INTO research_ingest_inventory_versions
  (inventory_id, file_sha256, byte_size, first_seen_at, last_seen_at)
SELECT m.old_id, v.file_sha256, v.byte_size, v.first_seen_at, v.last_seen_at
FROM poi_inventory_path_moves m
JOIN research_ingest_inventory_versions v ON v.inventory_id = m.current_id
ON CONFLICT (inventory_id, file_sha256) DO UPDATE SET
  first_seen_at = LEAST(research_ingest_inventory_versions.first_seen_at, EXCLUDED.first_seen_at),
  last_seen_at = GREATEST(research_ingest_inventory_versions.last_seen_at, EXCLUDED.last_seen_at);

UPDATE research_ingest_inventory_edits e SET inventory_id = m.old_id
FROM poi_inventory_path_moves m WHERE e.inventory_id = m.current_id;

UPDATE research_ingest_inventory old SET
  format = fresh.format,
  file_sha256 = fresh.file_sha256,
  byte_size = fresh.byte_size,
  modified_at = fresh.modified_at,
  extractor_version = fresh.extractor_version,
  last_seen_at = GREATEST(old.last_seen_at, fresh.last_seen_at),
  scanned_at = GREATEST(old.scanned_at, fresh.scanned_at),
  missing_at = fresh.missing_at,
  scan_error = fresh.scan_error,
  updated_at = GREATEST(old.updated_at, fresh.updated_at)
FROM poi_inventory_path_moves m
JOIN research_ingest_inventory fresh ON fresh.id = m.current_id
WHERE old.id = m.old_id;

DELETE FROM research_ingest_inventory fresh
USING poi_inventory_path_moves m WHERE fresh.id = m.current_id;

UPDATE research_ingest_inventory old SET logical_path = m.new_path
FROM poi_inventory_path_moves m WHERE old.id = m.old_id;

UPDATE research_source_files f SET logical_path = m.new_path
FROM poi_source_path_moves m WHERE f.id = m.id;
