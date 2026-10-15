ALTER TABLE research_geocode_cache ADD COLUMN payload jsonb;
COMMENT ON COLUMN research_geocode_cache.payload IS 'Versioned reverse location fields; exact point key. Null preserves legacy forward-cache entries.';
