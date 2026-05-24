-- 202605241200__baseline.sql
-- Initial POI map schema: PostGIS, POIs, users, and guest seed data.

CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE public.pois (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  category text NOT NULL,
  description text,
  photo_url text,
  address text,
  website text,
  hours text,
  geom geography(POINT, 4326) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX pois_geom_gix ON public.pois USING gist (geom);
CREATE INDEX pois_category_idx ON public.pois (category);

CREATE TABLE public.users (
  id text PRIMARY KEY,
  display_name text NOT NULL DEFAULT 'Guest',
  tier text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'premium')),
  is_guest boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_preferences (
  user_id text PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  basemap_id text,
  last_center_lng double precision,
  last_center_lat double precision,
  last_zoom double precision,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.users (id, display_name, tier, is_guest)
VALUES ('guest', 'Guest', 'free', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.user_preferences (user_id)
VALUES ('guest')
ON CONFLICT (user_id) DO NOTHING;
