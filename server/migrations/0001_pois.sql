CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS pois (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  category    text NOT NULL,
  description text,
  photo_url   text,
  geom        geography(POINT, 4326) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pois_geom_gix ON pois USING GIST (geom);
CREATE INDEX IF NOT EXISTS pois_category_idx ON pois (category);
