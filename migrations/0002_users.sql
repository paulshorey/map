CREATE TABLE IF NOT EXISTS users (
  id             text PRIMARY KEY,
  display_name   text NOT NULL DEFAULT 'Guest',
  tier           text NOT NULL DEFAULT 'free' CHECK (tier IN ('free', 'premium')),
  is_guest       boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id        text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  basemap_id     text,
  last_center_lng double precision,
  last_center_lat double precision,
  last_zoom      double precision,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO users (id, display_name, tier, is_guest)
VALUES ('guest', 'Guest', 'free', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_preferences (user_id)
VALUES ('guest')
ON CONFLICT (user_id) DO NOTHING;
