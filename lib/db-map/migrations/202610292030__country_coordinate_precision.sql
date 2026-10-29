-- Country-level geocode results (OSM country boundaries) were previously forced into
-- `region` or `city`. Widen both precision vocabularies; existing values stay valid.
ALTER TABLE research_poi_geocodes
  DROP CONSTRAINT research_poi_geocodes_precision_check,
  ADD CONSTRAINT research_poi_geocodes_precision_check
    CHECK (precision IN ('point', 'city', 'region', 'country'));

ALTER TABLE research_pois
  DROP CONSTRAINT research_pois_coordinate_precision_check,
  ADD CONSTRAINT research_pois_coordinate_precision_check
    CHECK (coordinate_precision IN ('point', 'city', 'region', 'country'));
