-- The listing text that produced each canonical location (the members' lookup queries), so the
-- drawer can show it for canonical locations as it did for coordinate evidence.
ALTER TABLE canonical_poi_locations ADD COLUMN queries text[] NOT NULL DEFAULT '{}';
