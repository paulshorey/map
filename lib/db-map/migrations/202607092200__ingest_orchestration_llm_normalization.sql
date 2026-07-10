-- Durable file-first orchestration and versioned hybrid normalization.

CREATE TABLE public.research_source_files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           uuid NOT NULL REFERENCES public.research_sources(id) ON DELETE CASCADE,
  logical_path        text NOT NULL,
  category_slug       text NOT NULL,
  mode                text NOT NULL DEFAULT 'snapshot' CHECK (mode IN ('snapshot','incremental')),
  format              text NOT NULL CHECK (format IN ('json','jsonl','csv')),
  extractor_version   text NOT NULL,
  active_version_id   uuid,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, logical_path)
);

CREATE TABLE public.research_source_file_versions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file_id      uuid NOT NULL REFERENCES public.research_source_files(id) ON DELETE CASCADE,
  file_sha256         text NOT NULL,
  byte_size           bigint NOT NULL,
  record_count        integer,
  extractor_version   text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','extracting','complete','partial','failed')),
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  UNIQUE (source_file_id, file_sha256, extractor_version)
);

ALTER TABLE public.research_source_files
  ADD CONSTRAINT research_source_files_active_version_fkey
  FOREIGN KEY (active_version_id)
  REFERENCES public.research_source_file_versions(id)
  ON DELETE SET NULL;

CREATE TABLE public.research_ingest_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_file_version_id uuid NOT NULL REFERENCES public.research_source_file_versions(id),
  source_id             uuid NOT NULL REFERENCES public.research_sources(id),
  category_slug         text NOT NULL,
  mode                  text NOT NULL DEFAULT 'resume'
                        CHECK (mode IN ('resume','reprocess','from_stage','shadow')),
  requested_from_stage  text,
  pipeline_versions     jsonb NOT NULL DEFAULT '{}',
  options               jsonb NOT NULL DEFAULT '{}',
  counters              jsonb NOT NULL DEFAULT '{}',
  status                text NOT NULL DEFAULT 'planned'
                        CHECK (status IN (
                          'planned','running','paused','waiting_budget',
                          'partial','succeeded','failed','cancelled'
                        )),
  current_stage         text,
  resumed_from_run_id   uuid REFERENCES public.research_ingest_runs(id) ON DELETE SET NULL,
  fatal_error           text,
  resume_command        text,
  started_at            timestamptz,
  heartbeat_at          timestamptz,
  stopped_at            timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_ingest_runs_file_idx
  ON public.research_ingest_runs (source_file_version_id, created_at DESC);
CREATE INDEX research_ingest_runs_status_idx
  ON public.research_ingest_runs (status, heartbeat_at);

CREATE TABLE public.research_ingest_run_records (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES public.research_ingest_runs(id) ON DELETE CASCADE,
  source_file_version_id uuid NOT NULL REFERENCES public.research_source_file_versions(id) ON DELETE CASCADE,
  source_record_id      text,
  source_ordinal        integer NOT NULL,
  raw_hash              text,
  research_poi_id       uuid REFERENCES public.research_pois(id) ON DELETE SET NULL,
  observation_id        uuid,
  extract_state         text NOT NULL DEFAULT 'pending'
                        CHECK (extract_state IN ('pending','written','unchanged','rejected','failed')),
  attempts              integer NOT NULL DEFAULT 0,
  last_error_class      text,
  last_error            text,
  next_retry_at         timestamptz,
  first_attempt_at      timestamptz,
  last_attempt_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, source_ordinal)
);
CREATE INDEX research_ingest_run_records_state_idx
  ON public.research_ingest_run_records (run_id, extract_state, source_ordinal);

CREATE TABLE public.research_poi_observations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_poi_id       uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  source_file_version_id uuid REFERENCES public.research_source_file_versions(id) ON DELETE SET NULL,
  raw_content_hash      text NOT NULL,
  raw                   jsonb NOT NULL,
  captured              jsonb NOT NULL DEFAULT '{}',
  source_is_poi_hint    boolean,
  redacted_paths        text[] NOT NULL DEFAULT '{}',
  first_seen_at         timestamptz NOT NULL DEFAULT now(),
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (research_poi_id, raw_content_hash)
);
CREATE INDEX research_poi_observations_poi_idx
  ON public.research_poi_observations (research_poi_id, last_seen_at DESC);

ALTER TABLE public.research_ingest_run_records
  ADD CONSTRAINT research_ingest_run_records_observation_fkey
  FOREIGN KEY (observation_id)
  REFERENCES public.research_poi_observations(id)
  ON DELETE SET NULL;

CREATE TABLE public.research_normalization_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_poi_id       uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  observation_id        uuid NOT NULL REFERENCES public.research_poi_observations(id) ON DELETE CASCADE,
  input_hash            text NOT NULL,
  prompt_version        text NOT NULL,
  schema_version        text NOT NULL,
  profile_version       text NOT NULL,
  examples_version      text NOT NULL,
  provider              text NOT NULL,
  requested_model       text NOT NULL,
  returned_model        text,
  status                text NOT NULL
                        CHECK (status IN ('started','succeeded','failed','repaired')),
  request_json          jsonb NOT NULL,
  response_json         jsonb,
  response_text         text,
  finish_reason         text,
  prompt_tokens         integer,
  cached_tokens         integer,
  completion_tokens     integer,
  total_tokens          integer,
  estimated_cost_usd    numeric,
  latency_ms            integer,
  attempt               integer NOT NULL DEFAULT 1,
  repaired_from_id      uuid REFERENCES public.research_normalization_requests(id) ON DELETE SET NULL,
  error                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);
CREATE INDEX research_normalization_requests_input_idx
  ON public.research_normalization_requests (research_poi_id, input_hash, created_at DESC);

CREATE TABLE public.research_poi_normalizations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_poi_id       uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  observation_id        uuid NOT NULL REFERENCES public.research_poi_observations(id) ON DELETE CASCADE,
  request_id            uuid REFERENCES public.research_normalization_requests(id) ON DELETE SET NULL,
  input_hash            text NOT NULL,
  normalizer_version    text NOT NULL,
  status                text NOT NULL CHECK (status IN ('accepted','rejected','degraded','failed')),
  is_poi                boolean NOT NULL,
  invalid_reason        text,
  entity_kind           text,
  display_name          text,
  match_name            text,
  edition_year          integer,
  aliases               text[] NOT NULL DEFAULT '{}',
  description           text,
  website               text,
  website_domain        text,
  phone                 text,
  email                 text,
  address               text,
  venue                 text,
  city                  text,
  region                text,
  country_code          text,
  category_slugs        text[],
  starts_at             timestamptz,
  ends_at               timestamptz,
  date_precision        text CHECK (date_precision IN ('datetime','day','month','year')),
  attributes            jsonb NOT NULL DEFAULT '{}',
  field_evidence        jsonb NOT NULL DEFAULT '{}',
  model_output          jsonb NOT NULL DEFAULT '{}',
  warnings              text[] NOT NULL DEFAULT '{}',
  match_fingerprint     text,
  activated_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (research_poi_id, input_hash)
);
CREATE INDEX research_poi_normalizations_poi_idx
  ON public.research_poi_normalizations (research_poi_id, created_at DESC);
CREATE INDEX research_poi_normalizations_status_idx
  ON public.research_poi_normalizations (status, created_at);

CREATE TABLE public.research_poi_normalization_occurrences (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalization_id      uuid NOT NULL REFERENCES public.research_poi_normalizations(id) ON DELETE CASCADE,
  starts_at             timestamptz NOT NULL,
  ends_at               timestamptz,
  date_precision        text CHECK (date_precision IN ('datetime','day','month','year')),
  timezone              text,
  edition_year          integer,
  derivation            text NOT NULL CHECK (derivation IN ('explicit','structured_parse','llm_interpretation')),
  evidence              jsonb NOT NULL DEFAULT '{}',
  confidence            real,
  UNIQUE (normalization_id, starts_at)
);

CREATE TABLE public.research_poi_geocodes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalization_id      uuid NOT NULL REFERENCES public.research_poi_normalizations(id) ON DELETE CASCADE,
  input_hash            text NOT NULL,
  query_norm            text,
  provider              text NOT NULL,
  provider_version      text NOT NULL,
  lat                   double precision,
  lng                   double precision,
  precision             text CHECK (precision IN ('point','city','region')),
  status                text NOT NULL CHECK (status IN ('resolved','miss','rejected','failed')),
  validation            jsonb NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz,
  UNIQUE (normalization_id, input_hash)
);

CREATE TABLE public.research_poi_embeddings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  normalization_id      uuid NOT NULL REFERENCES public.research_poi_normalizations(id) ON DELETE CASCADE,
  input_hash            text NOT NULL,
  model                 text NOT NULL,
  model_version         text NOT NULL,
  embedding             real[] NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz,
  UNIQUE (normalization_id, input_hash)
);

CREATE TABLE public.research_pipeline_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid REFERENCES public.research_ingest_runs(id) ON DELETE SET NULL,
  target_kind           text NOT NULL CHECK (target_kind IN ('observation','normalization','research_poi','canonical_poi')),
  target_id             uuid NOT NULL,
  stage                 text NOT NULL CHECK (stage IN ('normalize','geocode','embed','match','consolidate','canonical_build')),
  desired_input_hash    text NOT NULL,
  stage_version         text NOT NULL,
  status                text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','leased','succeeded','retryable','quarantined','failed','cancelled')),
  claim_token           uuid,
  lease_owner           text,
  lease_expires_at      timestamptz,
  attempts              integer NOT NULL DEFAULT 0,
  next_retry_at         timestamptz,
  error_class           text,
  error                 text,
  error_details         jsonb,
  output_artifact_id    uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  started_at            timestamptz,
  completed_at          timestamptz,
  UNIQUE (target_kind, target_id, stage, desired_input_hash)
);
CREATE INDEX research_pipeline_jobs_ready_idx
  ON public.research_pipeline_jobs (stage, status, next_retry_at, created_at);
CREATE INDEX research_pipeline_jobs_run_idx
  ON public.research_pipeline_jobs (run_id, stage, status);

CREATE TABLE public.research_canonical_memberships (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_poi_id       uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  normalization_id      uuid REFERENCES public.research_poi_normalizations(id) ON DELETE SET NULL,
  canonical_poi_id      uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  match_decision_id     uuid REFERENCES public.research_match_decisions(id) ON DELETE SET NULL,
  matcher_version       text NOT NULL,
  active                boolean NOT NULL DEFAULT true,
  assigned_at           timestamptz NOT NULL DEFAULT now(),
  retired_at            timestamptz,
  retirement_reason     text
);
CREATE UNIQUE INDEX research_canonical_memberships_active_poi_idx
  ON public.research_canonical_memberships (research_poi_id)
  WHERE active;
CREATE INDEX research_canonical_memberships_canonical_idx
  ON public.research_canonical_memberships (canonical_poi_id)
  WHERE active;

CREATE TABLE public.canonical_poi_builds (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_poi_id      uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  input_hash            text NOT NULL,
  builder_version       text NOT NULL,
  status                text NOT NULL CHECK (status IN ('accepted','degraded','failed')),
  fields                jsonb NOT NULL,
  field_provenance      jsonb NOT NULL DEFAULT '{}',
  warnings              text[] NOT NULL DEFAULT '{}',
  request_id            uuid REFERENCES public.research_normalization_requests(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  activated_at          timestamptz,
  UNIQUE (canonical_poi_id, input_hash)
);

CREATE TABLE public.canonical_poi_redirects (
  from_poi_id           uuid PRIMARY KEY REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  to_poi_id             uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  reason                text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (from_poi_id <> to_poi_id)
);

ALTER TABLE public.research_pois
  ADD COLUMN active_observation_id uuid,
  ADD COLUMN active_normalization_id uuid,
  ADD COLUMN matched_normalization_id uuid,
  ADD COLUMN normalization_state text NOT NULL DEFAULT 'pending'
    CHECK (normalization_state IN ('pending','active','active_stale','rejected','degraded','failed')),
  ADD COLUMN normalization_input_hash text,
  ADD COLUMN normalized_at timestamptz,
  ADD COLUMN retired_at timestamptz;

ALTER TABLE public.research_pois
  ADD CONSTRAINT research_pois_active_observation_fkey
  FOREIGN KEY (active_observation_id)
  REFERENCES public.research_poi_observations(id)
  ON DELETE SET NULL,
  ADD CONSTRAINT research_pois_active_normalization_fkey
  FOREIGN KEY (active_normalization_id)
  REFERENCES public.research_poi_normalizations(id)
  ON DELETE SET NULL,
  ADD CONSTRAINT research_pois_matched_normalization_fkey
  FOREIGN KEY (matched_normalization_id)
  REFERENCES public.research_poi_normalizations(id)
  ON DELETE SET NULL;

ALTER TABLE public.canonical_pois
  ADD COLUMN active_build_id uuid;
ALTER TABLE public.canonical_pois
  ADD CONSTRAINT canonical_pois_active_build_fkey
  FOREIGN KEY (active_build_id)
  REFERENCES public.canonical_poi_builds(id)
  ON DELETE SET NULL;

INSERT INTO public.research_poi_observations (
  research_poi_id,
  raw_content_hash,
  raw,
  captured,
  source_is_poi_hint,
  first_seen_at,
  last_seen_at
)
SELECT
  rp.id,
  COALESCE(rp.content_hash, md5(rp.raw::text)),
  rp.raw,
  jsonb_build_object(
    'name', rp.name,
    'description', rp.description,
    'website', rp.website,
    'source_url', rp.source_url,
    'phone', rp.phone,
    'email', rp.email,
    'address', rp.address,
    'city', rp.city,
    'region', rp.region,
    'country_code', rp.country_code,
    'lat', rp.lat,
    'lng', rp.lng,
    'raw_category', rp.raw_category,
    'attributes', rp.attributes
  ),
  rp.is_poi,
  rp.first_seen_at,
  rp.last_seen_at
FROM public.research_pois rp
ON CONFLICT (research_poi_id, raw_content_hash) DO NOTHING;

UPDATE public.research_pois rp
SET active_observation_id = o.id
FROM public.research_poi_observations o
WHERE o.research_poi_id = rp.id
  AND o.raw_content_hash = COALESCE(rp.content_hash, md5(rp.raw::text));

CREATE INDEX research_pois_normalization_state_idx
  ON public.research_pois (normalization_state, source_id, first_seen_at);

CREATE VIEW public.research_pois_current AS
SELECT
  rp.id,
  rp.source_id,
  rp.source_record_id,
  rp.ingest_category,
  rp.active_observation_id,
  rp.active_normalization_id,
  rp.normalization_state,
  rp.canonical_poi_id,
  COALESCE(n.display_name, rp.name) AS name,
  COALESCE(n.match_name, rp.name_normalized) AS name_normalized,
  COALESCE(n.description, rp.description) AS description,
  COALESCE(n.website, rp.website) AS website,
  COALESCE(n.website_domain, rp.website_domain) AS website_domain,
  rp.source_url,
  COALESCE(n.phone, rp.phone) AS phone,
  COALESCE(n.email, rp.email) AS email,
  COALESCE(n.address, rp.address) AS address,
  COALESCE(n.city, rp.city) AS city,
  COALESCE(n.region, rp.region) AS region,
  COALESCE(n.country_code, rp.country_code) AS country_code,
  rp.lng,
  rp.lat,
  COALESCE(n.starts_at, rp.starts_at) AS starts_at,
  COALESCE(n.ends_at, rp.ends_at) AS ends_at,
  COALESCE(n.date_precision, rp.date_precision) AS date_precision,
  rp.raw_category,
  COALESCE(n.category_slugs, rp.category_slugs) AS category_slugs,
  COALESCE(n.is_poi, rp.is_poi) AS is_poi,
  o.raw,
  COALESCE(o.captured->'attributes', '{}'::jsonb) || COALESCE(n.attributes, '{}'::jsonb) AS attributes,
  rp.content_embedding,
  rp.coordinate_source,
  rp.coordinate_precision,
  rp.geocode_query_norm,
  rp.first_seen_at,
  rp.last_seen_at
FROM public.research_pois rp
LEFT JOIN public.research_poi_observations o ON o.id = rp.active_observation_id
LEFT JOIN public.research_poi_normalizations n ON n.id = rp.active_normalization_id
WHERE rp.retired_at IS NULL;
