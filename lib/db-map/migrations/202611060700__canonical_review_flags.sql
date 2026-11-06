-- Filterable review flags on canonical POIs (troubleshooting, not publication policy).
-- Derived, not part of a canonical build: rebuildCanonicalPoi refreshes them for its POI and
-- `ingest:review-flags --refresh` refreshes all of them (for example after a capture is
-- reclassified). Known flags are listed in sql/review-flags.ts.
ALTER TABLE canonical_pois ADD COLUMN review_flags text[] NOT NULL DEFAULT '{}';
CREATE INDEX canonical_pois_review_flags_idx ON canonical_pois USING gin (review_flags);
