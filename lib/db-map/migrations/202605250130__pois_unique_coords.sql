-- 202605250130__pois_unique_coords.sql
-- Add unique constraint on (lng, lat) to prevent duplicate POIs at the same location.
-- Re-importing a POI at existing coordinates will update the row instead of creating a duplicate.

-- Drop the existing non-unique index
DROP INDEX IF EXISTS pois_coords_idx;

-- Remove any existing duplicates (keep the most recently created one)
DELETE FROM pois a
USING pois b
WHERE a.lng = b.lng
  AND a.lat = b.lat
  AND a.created_at < b.created_at;

-- Add unique constraint (creates an implicit index)
ALTER TABLE pois ADD CONSTRAINT pois_coords_unique UNIQUE (lng, lat);
