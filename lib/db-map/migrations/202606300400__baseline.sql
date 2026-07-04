-- 202606300400__baseline.sql
-- Fresh baseline for the two-layer POI ingestion architecture.
-- Layers: extensions · auth/app · research_* (raw) · canonical_* (published).
-- See .cursor/plans/poi-ingestion-pipeline.md and poi-ingestion-implementation.md.
--
-- PORTABILITY NOTE: this baseline deliberately does NOT use PostGIS or pgvector
-- (neither is available on the target databases). Coordinates are plain lng/lat
-- doubles; spatial blocking is done via a bbox prefilter + Haversine in app code.
-- Embeddings are stored as real[] and compared in app code on the blocked candidate
-- set (matching blocks by geography first, so no ANN index is needed). pg_trgm powers
-- name similarity; tstzrange GiST (core, no extension) powers event-date filtering.
-- migrate.mjs wraps this file in a transaction; do not add BEGIN/COMMIT.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── Auth / app ────────────────────────────────────────────────
CREATE TABLE public.users (
  id           text PRIMARY KEY,
  display_name text NOT NULL DEFAULT 'Guest',
  tier         text NOT NULL DEFAULT 'free' CHECK (tier IN ('free','premium')),
  is_guest     boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.user_preferences (
  user_id         text PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  basemap_id      text,
  last_center_lng double precision,
  last_center_lat double precision,
  last_zoom       double precision,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.users (id, display_name, tier, is_guest)
VALUES ('guest','Guest','free',true) ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_preferences (user_id)
VALUES ('guest') ON CONFLICT (user_id) DO NOTHING;

-- ── research_sources (source registry) ────────────────────────
CREATE TABLE public.research_sources (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text UNIQUE NOT NULL,
  name          text NOT NULL,
  homepage      text,
  license       text,
  attribution   text,
  trust         integer NOT NULL DEFAULT 50,
  last_ingested_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── canonical_categories (taxonomy; seeded from code) ─────────
CREATE TABLE public.canonical_categories (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text UNIQUE NOT NULL,
  display_name text NOT NULL,
  parent_id    uuid REFERENCES public.canonical_categories(id),
  description  text,
  icon         text,
  color        text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  is_temporal  boolean NOT NULL DEFAULT false,  -- true for event categories (festivals)
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canonical_categories_parent_idx ON public.canonical_categories (parent_id);

-- ── canonical_pois (published, user-facing places) ────────────
CREATE TABLE public.canonical_pois (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  description   text,
  photo_url     text,
  address       text,
  website       text,
  hours         text,
  phone         text,
  lng           double precision NOT NULL,
  lat           double precision NOT NULL,
  attributes       jsonb NOT NULL DEFAULT '{}',
  field_provenance jsonb NOT NULL DEFAULT '{}',
  popularity    integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'published' CHECK (status IN ('published','draft','hidden')),
  -- denormalized shortcut to the primary category (marker color/label on the map).
  -- Source of truth for ALL categories is canonical_poi_categories; this is a hot-path
  -- read optimization kept consistent by the merge step (M8) and insertPois.
  primary_category_id uuid REFERENCES public.canonical_categories(id) ON DELETE SET NULL,
  -- event/temporal fields (NULL for permanent POIs):
  starts_at      timestamptz,
  ends_at        timestamptz,
  date_precision text CHECK (date_precision IN ('datetime','day','month','year')),
  event_range    tstzrange GENERATED ALWAYS AS (
    CASE WHEN starts_at IS NULL THEN NULL
         ELSE tstzrange(starts_at, COALESCE(ends_at, starts_at), '[]') END
  ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX canonical_pois_lat_idx     ON public.canonical_pois (lat);
CREATE INDEX canonical_pois_lng_idx     ON public.canonical_pois (lng);
CREATE INDEX canonical_pois_name_trgm   ON public.canonical_pois USING gin ((lower(name)) gin_trgm_ops);
CREATE INDEX canonical_pois_status_idx  ON public.canonical_pois (status);
CREATE INDEX canonical_pois_event_gix   ON public.canonical_pois USING gist (event_range);
CREATE INDEX canonical_pois_starts_idx  ON public.canonical_pois (starts_at);
CREATE INDEX canonical_pois_primary_cat_idx ON public.canonical_pois (primary_category_id);

-- ── research_pois (raw, one row per (source, record)) ─────────
CREATE TABLE public.research_pois (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id        uuid NOT NULL REFERENCES public.research_sources(id),
  source_record_id text NOT NULL,
  ingest_category  text,

  -- processing state is the NULL-ness of derived columns (no status columns):
  name             text,
  name_normalized  text,              -- NULL ⇒ needs normalize
  description      text,
  website          text,              -- OFFICIAL site only
  website_domain   text,
  source_url       text,              -- the source's listing/detail page (provenance, ≠ website)
  phone            text,
  email            text,
  address          text,
  city             text,
  region           text,
  country_code     text,
  lng              double precision,  -- NULL ⇒ needs geocode
  lat              double precision,
  starts_at        timestamptz,
  ends_at          timestamptz,
  date_precision   text CHECK (date_precision IN ('datetime','day','month','year')),

  raw_category     text,               -- the source's verbatim category string (pre-mapping)
  category_slugs   text[],             -- resolved canonical slugs (normalize stage); NULL ⇒ not yet resolved
  is_poi           boolean NOT NULL DEFAULT true,  -- validity gate: false ⇒ never promoted to canonical
  raw              jsonb NOT NULL,
  attributes       jsonb,

  content_embedding real[],           -- NULL ⇒ needs embed; cosine computed in app on blocked candidates
  content_hash     text,              -- version of input; change ⇒ reset derived cols to NULL

  canonical_poi_id uuid REFERENCES public.canonical_pois(id) ON DELETE SET NULL, -- NULL ⇒ needs match

  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  coordinate_source text CHECK (coordinate_source IN ('source','url','geocode')),
  coordinate_precision text CHECK (coordinate_precision IN ('point','city','region')),
  geocode_query_norm text,

  UNIQUE (source_id, source_record_id)
);
CREATE INDEX research_pois_lat_idx    ON public.research_pois (lat);
CREATE INDEX research_pois_lng_idx    ON public.research_pois (lng);
CREATE INDEX research_pois_name_trgm  ON public.research_pois USING gin (name_normalized gin_trgm_ops);
CREATE INDEX research_pois_canon_idx  ON public.research_pois (canonical_poi_id);
CREATE INDEX research_pois_category_slugs_gix ON public.research_pois USING gin (category_slugs);
-- "needs work" = a derived column IS NULL; partial indexes keep resumable scans cheap:
CREATE INDEX research_pois_todo_normalize ON public.research_pois (id) WHERE name_normalized   IS NULL;
CREATE INDEX research_pois_todo_geocode   ON public.research_pois (id) WHERE lat               IS NULL;
CREATE INDEX research_pois_todo_embed     ON public.research_pois (id) WHERE content_embedding IS NULL;
CREATE INDEX research_pois_todo_match     ON public.research_pois (id) WHERE canonical_poi_id  IS NULL;

-- ── canonical_poi_categories (M:N place ↔ category) ───────────
CREATE TABLE public.canonical_poi_categories (
  poi_id      uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  category_id uuid NOT NULL REFERENCES public.canonical_categories(id) ON DELETE CASCADE,
  is_primary  boolean NOT NULL DEFAULT false,
  PRIMARY KEY (poi_id, category_id)
);
-- composite (category_id, poi_id) enables index-only reverse lookups for the
-- category filter (e.g. "all POIs in category X or its descendants").
CREATE INDEX canonical_poi_categories_cat_idx ON public.canonical_poi_categories (category_id, poi_id);

-- ── canonical_poi_occurrences (recurring event editions) ──────
CREATE TABLE public.canonical_poi_occurrences (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poi_id         uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz,
  date_precision text CHECK (date_precision IN ('datetime','day','month','year')),
  occurrence_range tstzrange GENERATED ALWAYS AS (
    tstzrange(starts_at, COALESCE(ends_at, starts_at), '[]')
  ) STORED,
  UNIQUE (poi_id, starts_at)
);
CREATE INDEX canonical_poi_occurrences_poi_idx   ON public.canonical_poi_occurrences (poi_id);
CREATE INDEX canonical_poi_occurrences_range_gix ON public.canonical_poi_occurrences USING gist (occurrence_range);

-- ── research_match_decisions (audit) ──────────────────────────
CREATE TABLE public.research_match_decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_id      uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  candidate_poi_id uuid REFERENCES public.canonical_pois(id) ON DELETE SET NULL,
  score            real,
  signals          jsonb,
  decision         text NOT NULL CHECK (decision IN ('merge','new')),
  method           text NOT NULL CHECK (method IN ('strong_id','auto','llm','override')),
  llm_reason       text,
  decided_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_match_decisions_research_idx ON public.research_match_decisions (research_id);

-- ── research_match_overrides (developer corrections) ──────────
CREATE TABLE public.research_match_overrides (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_a   uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  record_b   uuid REFERENCES public.research_pois(id) ON DELETE CASCADE,
  rule       text NOT NULL CHECK (rule IN ('force_same','force_different')),
  note       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── research_geocode_cache (dedupe + remembered misses) ───────
CREATE TABLE public.research_geocode_cache (
  query_norm text PRIMARY KEY,
  lat        double precision,   -- NULL ⇒ remembered miss (query did not resolve)
  lng        double precision,
  precision  text,
  provider   text,
  fetched_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.research_pois
  ADD CONSTRAINT research_pois_geocode_query_norm_fkey
  FOREIGN KEY (geocode_query_norm)
  REFERENCES public.research_geocode_cache(query_norm)
  ON DELETE SET NULL;
