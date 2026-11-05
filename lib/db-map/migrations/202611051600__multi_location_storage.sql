-- Every known location per record and per canonical POI.
--
-- research_poi_locations: one row per location a geocode artifact knows for its research
-- record (the supplied point, the listed-text lookup or its city/country fallback, and the
-- rejected lookups kept as evidence). Rows are immutable per artifact; the active set is the
-- one whose geocode_id is the record's active_geocode_id.
--
-- canonical_poi_locations: the de-duplicated union of the accepted locations of a canonical
-- build's members. The map renders one marker per row; nothing is chosen away.
CREATE TABLE research_poi_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_poi_id uuid NOT NULL REFERENCES research_pois(id) ON DELETE CASCADE,
  geocode_id uuid NOT NULL REFERENCES research_poi_geocodes(id) ON DELETE CASCADE,
  normalization_id uuid NOT NULL REFERENCES research_poi_normalizations(id) ON DELETE CASCADE,
  -- Evidence class: supplied by the listing, or inferred from its text.
  kind text NOT NULL CHECK (kind IN ('source', 'inferred')),
  -- How it was obtained.
  origin text NOT NULL CHECK (origin IN (
    'source_coordinates', 'url_coordinates', 'listed_address_geocode',
    'city_fallback', 'country_fallback'
  )),
  -- What the point stands for.
  role text NOT NULL CHECK (role IN ('venue', 'address', 'locality', 'region', 'country')),
  precision text NOT NULL CHECK (precision IN ('point', 'city', 'region', 'country')),
  status text NOT NULL CHECK (status IN ('accepted', 'rejected')),
  reason text,
  lat double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  label text,
  query text,
  query_basis text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  logic_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX research_poi_locations_artifact_point_key
  ON research_poi_locations (geocode_id, kind, origin, status, lat, lng);
CREATE INDEX research_poi_locations_poi_idx ON research_poi_locations (research_poi_id);

CREATE TABLE canonical_poi_locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_poi_id uuid NOT NULL REFERENCES canonical_pois(id) ON DELETE CASCADE,
  build_id uuid NOT NULL REFERENCES canonical_poi_builds(id) ON DELETE CASCADE,
  lat double precision NOT NULL,
  lng double precision NOT NULL,
  -- Finest precision among the merged member locations at this point.
  precision text NOT NULL CHECK (precision IN ('point', 'city', 'region', 'country')),
  -- `general` when every merged member location is coarse or locality-only.
  specificity text NOT NULL CHECK (specificity IN ('general', 'precise')),
  kinds text[] NOT NULL,
  origins text[] NOT NULL,
  roles text[] NOT NULL,
  label text,
  is_primary boolean NOT NULL DEFAULT false,
  research_location_ids uuid[] NOT NULL,
  research_poi_ids uuid[] NOT NULL,
  sources text[] NOT NULL,
  ordinal integer NOT NULL,
  UNIQUE (build_id, ordinal)
);
CREATE INDEX canonical_poi_locations_poi_idx ON canonical_poi_locations (canonical_poi_id);
CREATE INDEX canonical_poi_locations_lat_idx ON canonical_poi_locations (lat);
CREATE INDEX canonical_poi_locations_lng_idx ON canonical_poi_locations (lng);
