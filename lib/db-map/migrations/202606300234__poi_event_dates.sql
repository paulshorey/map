-- 202606300234__poi_event_dates.sql
-- Add optional event start/end dates to POIs (temporal POIs such as music festivals).
-- Permanent POIs (gardens, campgrounds, ...) leave these NULL and behave exactly as before.
-- scripts/migrate.mjs wraps this file in a transaction; do not add BEGIN/COMMIT here.

ALTER TABLE public.pois
  ADD COLUMN starts_at      timestamptz,
  ADD COLUMN ends_at        timestamptz,
  ADD COLUMN date_precision text
    CHECK (date_precision IN ('datetime', 'day', 'month', 'year'));

-- Generated range column for efficient "events overlapping [from, to]" filtering.
-- NULL for permanent POIs; [starts_at, ends_at] (end defaults to start) for events.
ALTER TABLE public.pois
  ADD COLUMN event_range tstzrange
  GENERATED ALWAYS AS (
    CASE
      WHEN starts_at IS NULL THEN NULL
      ELSE tstzrange(starts_at, COALESCE(ends_at, starts_at), '[]')
    END
  ) STORED;

-- GiST on the range type is built into core Postgres (no extension needed).
CREATE INDEX pois_event_range_gix ON public.pois USING gist (event_range);
CREATE INDEX pois_starts_idx ON public.pois (starts_at);
