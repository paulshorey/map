-- Aggressive conflation support: proximity match audit method + centroid references.

ALTER TABLE public.research_match_decisions
  DROP CONSTRAINT research_match_decisions_method_check,
  ADD CONSTRAINT research_match_decisions_method_check
  CHECK (method IN ('strong_id','auto','llm','override','proximity'));

CREATE TABLE public.geo_centroids (
  id            bigint PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('city','country')),
  name          text NOT NULL,
  admin1        text,
  country_code  text,
  population    bigint,
  lat           double precision NOT NULL,
  lng           double precision NOT NULL
);
CREATE INDEX geo_centroids_lat_idx ON public.geo_centroids (lat);
CREATE INDEX geo_centroids_lng_idx ON public.geo_centroids (lng);
CREATE INDEX geo_centroids_kind_idx ON public.geo_centroids (kind);
