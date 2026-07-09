--
-- PostgreSQL database dump
--



SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: canonical_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    display_name text NOT NULL,
    parent_id uuid,
    description text,
    icon text,
    color text,
    sort_order integer DEFAULT 0 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    is_temporal boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: canonical_poi_builds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_poi_builds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_poi_id uuid NOT NULL,
    input_hash text NOT NULL,
    builder_version text NOT NULL,
    status text NOT NULL,
    fields jsonb NOT NULL,
    field_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    warnings text[] DEFAULT '{}'::text[] NOT NULL,
    request_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT canonical_poi_builds_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'degraded'::text, 'failed'::text])))
);


--
-- Name: canonical_poi_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_poi_categories (
    poi_id uuid NOT NULL,
    category_id uuid NOT NULL,
    is_primary boolean DEFAULT false NOT NULL
);


--
-- Name: canonical_poi_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_poi_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    poi_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    date_precision text,
    occurrence_range tstzrange GENERATED ALWAYS AS (tstzrange(starts_at, COALESCE(ends_at, starts_at), '[]'::text)) STORED,
    CONSTRAINT canonical_poi_occurrences_date_precision_check CHECK ((date_precision = ANY (ARRAY['datetime'::text, 'day'::text, 'month'::text, 'year'::text])))
);


--
-- Name: canonical_poi_redirects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_poi_redirects (
    from_poi_id uuid NOT NULL,
    to_poi_id uuid NOT NULL,
    reason text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canonical_poi_redirects_check CHECK ((from_poi_id <> to_poi_id))
);


--
-- Name: canonical_pois; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_pois (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    photo_url text,
    address text,
    website text,
    hours text,
    phone text,
    lng double precision NOT NULL,
    lat double precision NOT NULL,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    field_provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    popularity integer DEFAULT 1 NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    primary_category_id uuid,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    date_precision text,
    event_range tstzrange GENERATED ALWAYS AS (
CASE
    WHEN (starts_at IS NULL) THEN NULL::tstzrange
    ELSE tstzrange(starts_at, COALESCE(ends_at, starts_at), '[]'::text)
END) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    active_build_id uuid,
    CONSTRAINT canonical_pois_date_precision_check CHECK ((date_precision = ANY (ARRAY['datetime'::text, 'day'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT canonical_pois_status_check CHECK ((status = ANY (ARRAY['published'::text, 'draft'::text, 'hidden'::text])))
);


--
-- Name: geo_centroids; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.geo_centroids (
    id bigint NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    admin1 text,
    country_code text,
    population bigint,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    CONSTRAINT geo_centroids_kind_check CHECK ((kind = ANY (ARRAY['city'::text, 'country'::text])))
);


--
-- Name: research_canonical_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_canonical_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    research_poi_id uuid NOT NULL,
    normalization_id uuid,
    canonical_poi_id uuid NOT NULL,
    match_decision_id uuid,
    matcher_version text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    retirement_reason text
);


--
-- Name: research_consolidation_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_consolidation_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_a uuid NOT NULL,
    canonical_b uuid NOT NULL,
    same_place boolean NOT NULL,
    reason text,
    method text DEFAULT 'llm'::text NOT NULL,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_consolidation_decisions_method_check CHECK ((method = ANY (ARRAY['llm'::text, 'override'::text]))),
    CONSTRAINT research_consolidation_decisions_pair_ordered CHECK ((canonical_a < canonical_b))
);


--
-- Name: research_geocode_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_geocode_cache (
    query_norm text NOT NULL,
    lat double precision,
    lng double precision,
    "precision" text,
    provider text,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: research_ingest_run_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_ingest_run_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    source_file_version_id uuid NOT NULL,
    source_record_id text,
    source_ordinal integer NOT NULL,
    raw_hash text,
    research_poi_id uuid,
    observation_id uuid,
    extract_state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    last_error_class text,
    last_error text,
    next_retry_at timestamp with time zone,
    first_attempt_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_ingest_run_records_extract_state_check CHECK ((extract_state = ANY (ARRAY['pending'::text, 'written'::text, 'unchanged'::text, 'rejected'::text, 'failed'::text])))
);


--
-- Name: research_ingest_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_ingest_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_file_version_id uuid NOT NULL,
    source_id uuid NOT NULL,
    category_slug text NOT NULL,
    mode text DEFAULT 'resume'::text NOT NULL,
    requested_from_stage text,
    pipeline_versions jsonb DEFAULT '{}'::jsonb NOT NULL,
    options jsonb DEFAULT '{}'::jsonb NOT NULL,
    counters jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'planned'::text NOT NULL,
    current_stage text,
    resumed_from_run_id uuid,
    fatal_error text,
    resume_command text,
    started_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    stopped_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_ingest_runs_mode_check CHECK ((mode = ANY (ARRAY['resume'::text, 'reprocess'::text, 'from_stage'::text, 'shadow'::text]))),
    CONSTRAINT research_ingest_runs_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'running'::text, 'paused'::text, 'waiting_budget'::text, 'partial'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: research_match_decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_match_decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    research_id uuid NOT NULL,
    candidate_poi_id uuid,
    score real,
    signals jsonb,
    decision text NOT NULL,
    method text NOT NULL,
    llm_reason text,
    decided_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_match_decisions_decision_check CHECK ((decision = ANY (ARRAY['merge'::text, 'new'::text]))),
    CONSTRAINT research_match_decisions_method_check CHECK ((method = ANY (ARRAY['strong_id'::text, 'auto'::text, 'llm'::text, 'override'::text, 'proximity'::text])))
);


--
-- Name: research_match_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_match_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    record_a uuid NOT NULL,
    record_b uuid,
    rule text NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_match_overrides_rule_check CHECK ((rule = ANY (ARRAY['force_same'::text, 'force_different'::text])))
);


--
-- Name: research_normalization_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_normalization_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    research_poi_id uuid NOT NULL,
    observation_id uuid NOT NULL,
    input_hash text NOT NULL,
    prompt_version text NOT NULL,
    schema_version text NOT NULL,
    profile_version text NOT NULL,
    examples_version text NOT NULL,
    provider text NOT NULL,
    requested_model text NOT NULL,
    returned_model text,
    status text NOT NULL,
    request_json jsonb NOT NULL,
    response_json jsonb,
    response_text text,
    finish_reason text,
    prompt_tokens integer,
    cached_tokens integer,
    completion_tokens integer,
    total_tokens integer,
    estimated_cost_usd numeric,
    latency_ms integer,
    attempt integer DEFAULT 1 NOT NULL,
    repaired_from_id uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT research_normalization_requests_status_check CHECK ((status = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text, 'repaired'::text])))
);


--
-- Name: research_pipeline_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_pipeline_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid,
    target_kind text NOT NULL,
    target_id uuid NOT NULL,
    stage text NOT NULL,
    desired_input_hash text NOT NULL,
    stage_version text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    claim_token uuid,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    next_retry_at timestamp with time zone,
    error_class text,
    error text,
    error_details jsonb,
    output_artifact_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    CONSTRAINT research_pipeline_jobs_stage_check CHECK ((stage = ANY (ARRAY['normalize'::text, 'geocode'::text, 'embed'::text, 'match'::text, 'consolidate'::text, 'canonical_build'::text]))),
    CONSTRAINT research_pipeline_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'leased'::text, 'succeeded'::text, 'retryable'::text, 'quarantined'::text, 'failed'::text, 'cancelled'::text]))),
    CONSTRAINT research_pipeline_jobs_target_kind_check CHECK ((target_kind = ANY (ARRAY['observation'::text, 'normalization'::text, 'research_poi'::text, 'canonical_poi'::text])))
);


--
-- Name: research_poi_embeddings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_poi_embeddings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    normalization_id uuid NOT NULL,
    input_hash text NOT NULL,
    model text NOT NULL,
    model_version text NOT NULL,
    embedding real[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone
);


--
-- Name: research_poi_geocodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_poi_geocodes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    normalization_id uuid NOT NULL,
    input_hash text NOT NULL,
    query_norm text,
    provider text NOT NULL,
    provider_version text NOT NULL,
    lat double precision,
    lng double precision,
    "precision" text,
    status text NOT NULL,
    validation jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    activated_at timestamp with time zone,
    CONSTRAINT research_poi_geocodes_precision_check CHECK (("precision" = ANY (ARRAY['point'::text, 'city'::text, 'region'::text]))),
    CONSTRAINT research_poi_geocodes_status_check CHECK ((status = ANY (ARRAY['resolved'::text, 'miss'::text, 'rejected'::text, 'failed'::text])))
);


--
-- Name: research_poi_normalization_occurrences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_poi_normalization_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    normalization_id uuid CONSTRAINT research_poi_normalization_occurrence_normalization_id_not_null NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone,
    date_precision text,
    timezone text,
    edition_year integer,
    derivation text NOT NULL,
    evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    confidence real,
    CONSTRAINT research_poi_normalization_occurrences_date_precision_check CHECK ((date_precision = ANY (ARRAY['datetime'::text, 'day'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT research_poi_normalization_occurrences_derivation_check CHECK ((derivation = ANY (ARRAY['explicit'::text, 'structured_parse'::text, 'llm_interpretation'::text])))
);


--
-- Name: research_poi_normalizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_poi_normalizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    research_poi_id uuid NOT NULL,
    observation_id uuid NOT NULL,
    request_id uuid,
    input_hash text NOT NULL,
    normalizer_version text NOT NULL,
    status text NOT NULL,
    is_poi boolean NOT NULL,
    invalid_reason text,
    entity_kind text,
    display_name text,
    match_name text,
    edition_year integer,
    aliases text[] DEFAULT '{}'::text[] NOT NULL,
    description text,
    website text,
    website_domain text,
    phone text,
    email text,
    address text,
    venue text,
    city text,
    region text,
    country_code text,
    category_slugs text[],
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    date_precision text,
    attributes jsonb DEFAULT '{}'::jsonb NOT NULL,
    field_evidence jsonb DEFAULT '{}'::jsonb NOT NULL,
    model_output jsonb DEFAULT '{}'::jsonb NOT NULL,
    warnings text[] DEFAULT '{}'::text[] NOT NULL,
    match_fingerprint text,
    activated_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_poi_normalizations_date_precision_check CHECK ((date_precision = ANY (ARRAY['datetime'::text, 'day'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT research_poi_normalizations_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'rejected'::text, 'degraded'::text, 'failed'::text])))
);


--
-- Name: research_poi_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_poi_observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    research_poi_id uuid NOT NULL,
    source_file_version_id uuid,
    raw_content_hash text NOT NULL,
    raw jsonb NOT NULL,
    captured jsonb DEFAULT '{}'::jsonb NOT NULL,
    source_is_poi_hint boolean,
    redacted_paths text[] DEFAULT '{}'::text[] NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: research_pois; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_pois (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    source_record_id text NOT NULL,
    ingest_category text,
    name text,
    name_normalized text,
    description text,
    website text,
    website_domain text,
    source_url text,
    phone text,
    email text,
    address text,
    city text,
    region text,
    country_code text,
    lng double precision,
    lat double precision,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    date_precision text,
    raw_category text,
    category_slugs text[],
    is_poi boolean DEFAULT true NOT NULL,
    raw jsonb NOT NULL,
    attributes jsonb,
    content_embedding real[],
    content_hash text,
    canonical_poi_id uuid,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    coordinate_source text,
    coordinate_precision text,
    geocode_query_norm text,
    active_observation_id uuid,
    active_normalization_id uuid,
    matched_normalization_id uuid,
    normalization_state text DEFAULT 'pending'::text NOT NULL,
    normalization_input_hash text,
    normalized_at timestamp with time zone,
    retired_at timestamp with time zone,
    CONSTRAINT research_pois_coordinate_precision_check CHECK ((coordinate_precision = ANY (ARRAY['point'::text, 'city'::text, 'region'::text]))),
    CONSTRAINT research_pois_coordinate_source_check CHECK ((coordinate_source = ANY (ARRAY['source'::text, 'url'::text, 'geocode'::text]))),
    CONSTRAINT research_pois_date_precision_check CHECK ((date_precision = ANY (ARRAY['datetime'::text, 'day'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT research_pois_normalization_state_check CHECK ((normalization_state = ANY (ARRAY['pending'::text, 'active'::text, 'active_stale'::text, 'rejected'::text, 'degraded'::text, 'failed'::text])))
);


--
-- Name: research_pois_current; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.research_pois_current AS
 SELECT rp.id,
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
    (COALESCE((o.captured -> 'attributes'::text), '{}'::jsonb) || COALESCE(n.attributes, '{}'::jsonb)) AS attributes,
    rp.content_embedding,
    rp.coordinate_source,
    rp.coordinate_precision,
    rp.geocode_query_norm,
    rp.first_seen_at,
    rp.last_seen_at
   FROM ((public.research_pois rp
     LEFT JOIN public.research_poi_observations o ON ((o.id = rp.active_observation_id)))
     LEFT JOIN public.research_poi_normalizations n ON ((n.id = rp.active_normalization_id)))
  WHERE (rp.retired_at IS NULL);


--
-- Name: research_source_file_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_source_file_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_file_id uuid NOT NULL,
    file_sha256 text NOT NULL,
    byte_size bigint NOT NULL,
    record_count integer,
    extractor_version text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT research_source_file_versions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'extracting'::text, 'complete'::text, 'partial'::text, 'failed'::text])))
);


--
-- Name: research_source_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_source_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    logical_path text NOT NULL,
    category_slug text NOT NULL,
    mode text DEFAULT 'snapshot'::text NOT NULL,
    format text NOT NULL,
    extractor_version text NOT NULL,
    active_version_id uuid,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_source_files_format_check CHECK ((format = ANY (ARRAY['json'::text, 'jsonl'::text, 'csv'::text]))),
    CONSTRAINT research_source_files_mode_check CHECK ((mode = ANY (ARRAY['snapshot'::text, 'incremental'::text])))
);


--
-- Name: research_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    homepage text,
    license text,
    attribution text,
    trust integer DEFAULT 50 NOT NULL,
    last_ingested_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_preferences (
    user_id text NOT NULL,
    basemap_id text,
    last_center_lng double precision,
    last_center_lat double precision,
    last_zoom double precision,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    display_name text DEFAULT 'Guest'::text NOT NULL,
    tier text DEFAULT 'free'::text NOT NULL,
    is_guest boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_tier_check CHECK ((tier = ANY (ARRAY['free'::text, 'premium'::text])))
);


--
-- Name: canonical_categories canonical_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_categories
    ADD CONSTRAINT canonical_categories_pkey PRIMARY KEY (id);


--
-- Name: canonical_categories canonical_categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_categories
    ADD CONSTRAINT canonical_categories_slug_key UNIQUE (slug);


--
-- Name: canonical_poi_builds canonical_poi_builds_canonical_poi_id_input_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_builds
    ADD CONSTRAINT canonical_poi_builds_canonical_poi_id_input_hash_key UNIQUE (canonical_poi_id, input_hash);


--
-- Name: canonical_poi_builds canonical_poi_builds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_builds
    ADD CONSTRAINT canonical_poi_builds_pkey PRIMARY KEY (id);


--
-- Name: canonical_poi_categories canonical_poi_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_categories
    ADD CONSTRAINT canonical_poi_categories_pkey PRIMARY KEY (poi_id, category_id);


--
-- Name: canonical_poi_occurrences canonical_poi_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_occurrences
    ADD CONSTRAINT canonical_poi_occurrences_pkey PRIMARY KEY (id);


--
-- Name: canonical_poi_occurrences canonical_poi_occurrences_poi_id_starts_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_occurrences
    ADD CONSTRAINT canonical_poi_occurrences_poi_id_starts_at_key UNIQUE (poi_id, starts_at);


--
-- Name: canonical_poi_redirects canonical_poi_redirects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_redirects
    ADD CONSTRAINT canonical_poi_redirects_pkey PRIMARY KEY (from_poi_id);


--
-- Name: canonical_pois canonical_pois_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_pois
    ADD CONSTRAINT canonical_pois_pkey PRIMARY KEY (id);


--
-- Name: geo_centroids geo_centroids_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.geo_centroids
    ADD CONSTRAINT geo_centroids_pkey PRIMARY KEY (id);


--
-- Name: research_canonical_memberships research_canonical_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_canonical_memberships
    ADD CONSTRAINT research_canonical_memberships_pkey PRIMARY KEY (id);


--
-- Name: research_consolidation_decisions research_consolidation_decisions_pair_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_consolidation_decisions
    ADD CONSTRAINT research_consolidation_decisions_pair_unique UNIQUE (canonical_a, canonical_b);


--
-- Name: research_consolidation_decisions research_consolidation_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_consolidation_decisions
    ADD CONSTRAINT research_consolidation_decisions_pkey PRIMARY KEY (id);


--
-- Name: research_geocode_cache research_geocode_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_geocode_cache
    ADD CONSTRAINT research_geocode_cache_pkey PRIMARY KEY (query_norm);


--
-- Name: research_ingest_run_records research_ingest_run_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_run_records
    ADD CONSTRAINT research_ingest_run_records_pkey PRIMARY KEY (id);


--
-- Name: research_ingest_run_records research_ingest_run_records_run_id_source_ordinal_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_run_records
    ADD CONSTRAINT research_ingest_run_records_run_id_source_ordinal_key UNIQUE (run_id, source_ordinal);


--
-- Name: research_ingest_runs research_ingest_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_runs
    ADD CONSTRAINT research_ingest_runs_pkey PRIMARY KEY (id);


--
-- Name: research_match_decisions research_match_decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_match_decisions
    ADD CONSTRAINT research_match_decisions_pkey PRIMARY KEY (id);


--
-- Name: research_match_overrides research_match_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_match_overrides
    ADD CONSTRAINT research_match_overrides_pkey PRIMARY KEY (id);


--
-- Name: research_normalization_requests research_normalization_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_normalization_requests
    ADD CONSTRAINT research_normalization_requests_pkey PRIMARY KEY (id);


--
-- Name: research_pipeline_jobs research_pipeline_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_jobs
    ADD CONSTRAINT research_pipeline_jobs_pkey PRIMARY KEY (id);


--
-- Name: research_pipeline_jobs research_pipeline_jobs_target_kind_target_id_stage_desired__key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_jobs
    ADD CONSTRAINT research_pipeline_jobs_target_kind_target_id_stage_desired__key UNIQUE (target_kind, target_id, stage, desired_input_hash);


--
-- Name: research_poi_embeddings research_poi_embeddings_normalization_id_input_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_embeddings
    ADD CONSTRAINT research_poi_embeddings_normalization_id_input_hash_key UNIQUE (normalization_id, input_hash);


--
-- Name: research_poi_embeddings research_poi_embeddings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_embeddings
    ADD CONSTRAINT research_poi_embeddings_pkey PRIMARY KEY (id);


--
-- Name: research_poi_geocodes research_poi_geocodes_normalization_id_input_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_geocodes
    ADD CONSTRAINT research_poi_geocodes_normalization_id_input_hash_key UNIQUE (normalization_id, input_hash);


--
-- Name: research_poi_geocodes research_poi_geocodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_geocodes
    ADD CONSTRAINT research_poi_geocodes_pkey PRIMARY KEY (id);


--
-- Name: research_poi_normalization_occurrences research_poi_normalization_occur_normalization_id_starts_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_normalization_occurrences
    ADD CONSTRAINT research_poi_normalization_occur_normalization_id_starts_at_key UNIQUE (normalization_id, starts_at);


--
-- Name: research_poi_normalization_occurrences research_poi_normalization_occurrences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_normalization_occurrences
    ADD CONSTRAINT research_poi_normalization_occurrences_pkey PRIMARY KEY (id);


--
-- Name: research_poi_normalizations research_poi_normalizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_normalizations
    ADD CONSTRAINT research_poi_normalizations_pkey PRIMARY KEY (id);


--
-- Name: research_poi_normalizations research_poi_normalizations_research_poi_id_input_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_normalizations
    ADD CONSTRAINT research_poi_normalizations_research_poi_id_input_hash_key UNIQUE (research_poi_id, input_hash);


--
-- Name: research_poi_observations research_poi_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_observations
    ADD CONSTRAINT research_poi_observations_pkey PRIMARY KEY (id);


--
-- Name: research_poi_observations research_poi_observations_research_poi_id_raw_content_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_observations
    ADD CONSTRAINT research_poi_observations_research_poi_id_raw_content_hash_key UNIQUE (research_poi_id, raw_content_hash);


--
-- Name: research_pois research_pois_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_pkey PRIMARY KEY (id);


--
-- Name: research_pois research_pois_source_id_source_record_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_source_id_source_record_id_key UNIQUE (source_id, source_record_id);


--
-- Name: research_source_file_versions research_source_file_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_source_file_versions
    ADD CONSTRAINT research_source_file_versions_pkey PRIMARY KEY (id);


--
-- Name: research_source_file_versions research_source_file_versions_source_file_id_file_sha256_ex_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_source_file_versions
    ADD CONSTRAINT research_source_file_versions_source_file_id_file_sha256_ex_key UNIQUE (source_file_id, file_sha256, extractor_version);


--
-- Name: research_source_files research_source_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_source_files
    ADD CONSTRAINT research_source_files_pkey PRIMARY KEY (id);


--
-- Name: research_source_files research_source_files_source_id_logical_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_source_files
    ADD CONSTRAINT research_source_files_source_id_logical_path_key UNIQUE (source_id, logical_path);


--
-- Name: research_sources research_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_sources
    ADD CONSTRAINT research_sources_pkey PRIMARY KEY (id);


--
-- Name: research_sources research_sources_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_sources
    ADD CONSTRAINT research_sources_slug_key UNIQUE (slug);


--
-- Name: user_preferences user_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_pkey PRIMARY KEY (user_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: canonical_categories_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_categories_parent_idx ON public.canonical_categories USING btree (parent_id);


--
-- Name: canonical_poi_categories_cat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_poi_categories_cat_idx ON public.canonical_poi_categories USING btree (category_id, poi_id);


--
-- Name: canonical_poi_occurrences_poi_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_poi_occurrences_poi_idx ON public.canonical_poi_occurrences USING btree (poi_id);


--
-- Name: canonical_poi_occurrences_range_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_poi_occurrences_range_gix ON public.canonical_poi_occurrences USING gist (occurrence_range);


--
-- Name: canonical_pois_event_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_event_gix ON public.canonical_pois USING gist (event_range);


--
-- Name: canonical_pois_lat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_lat_idx ON public.canonical_pois USING btree (lat);


--
-- Name: canonical_pois_lng_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_lng_idx ON public.canonical_pois USING btree (lng);


--
-- Name: canonical_pois_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_name_trgm ON public.canonical_pois USING gin (lower(name) public.gin_trgm_ops);


--
-- Name: canonical_pois_primary_cat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_primary_cat_idx ON public.canonical_pois USING btree (primary_category_id);


--
-- Name: canonical_pois_starts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_starts_idx ON public.canonical_pois USING btree (starts_at);


--
-- Name: canonical_pois_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_status_idx ON public.canonical_pois USING btree (status);


--
-- Name: geo_centroids_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX geo_centroids_kind_idx ON public.geo_centroids USING btree (kind);


--
-- Name: geo_centroids_lat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX geo_centroids_lat_idx ON public.geo_centroids USING btree (lat);


--
-- Name: geo_centroids_lng_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX geo_centroids_lng_idx ON public.geo_centroids USING btree (lng);


--
-- Name: research_canonical_memberships_active_poi_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX research_canonical_memberships_active_poi_idx ON public.research_canonical_memberships USING btree (research_poi_id) WHERE active;


--
-- Name: research_canonical_memberships_canonical_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_canonical_memberships_canonical_idx ON public.research_canonical_memberships USING btree (canonical_poi_id) WHERE active;


--
-- Name: research_consolidation_decisions_b_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_consolidation_decisions_b_idx ON public.research_consolidation_decisions USING btree (canonical_b);


--
-- Name: research_ingest_run_records_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_ingest_run_records_state_idx ON public.research_ingest_run_records USING btree (run_id, extract_state, source_ordinal);


--
-- Name: research_ingest_runs_file_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_ingest_runs_file_idx ON public.research_ingest_runs USING btree (source_file_version_id, created_at DESC);


--
-- Name: research_ingest_runs_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_ingest_runs_status_idx ON public.research_ingest_runs USING btree (status, heartbeat_at);


--
-- Name: research_match_decisions_research_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_match_decisions_research_idx ON public.research_match_decisions USING btree (research_id);


--
-- Name: research_normalization_requests_input_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_normalization_requests_input_idx ON public.research_normalization_requests USING btree (research_poi_id, input_hash, created_at DESC);


--
-- Name: research_pipeline_jobs_ready_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_jobs_ready_idx ON public.research_pipeline_jobs USING btree (stage, status, next_retry_at, created_at);


--
-- Name: research_pipeline_jobs_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pipeline_jobs_run_idx ON public.research_pipeline_jobs USING btree (run_id, stage, status);


--
-- Name: research_poi_normalizations_poi_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_poi_normalizations_poi_idx ON public.research_poi_normalizations USING btree (research_poi_id, created_at DESC);


--
-- Name: research_poi_normalizations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_poi_normalizations_status_idx ON public.research_poi_normalizations USING btree (status, created_at);


--
-- Name: research_poi_observations_poi_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_poi_observations_poi_idx ON public.research_poi_observations USING btree (research_poi_id, last_seen_at DESC);


--
-- Name: research_pois_canon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_canon_idx ON public.research_pois USING btree (canonical_poi_id);


--
-- Name: research_pois_category_slugs_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_category_slugs_gix ON public.research_pois USING gin (category_slugs);


--
-- Name: research_pois_lat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_lat_idx ON public.research_pois USING btree (lat);


--
-- Name: research_pois_lng_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_lng_idx ON public.research_pois USING btree (lng);


--
-- Name: research_pois_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_name_trgm ON public.research_pois USING gin (name_normalized public.gin_trgm_ops);


--
-- Name: research_pois_normalization_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_normalization_state_idx ON public.research_pois USING btree (normalization_state, source_id, first_seen_at);


--
-- Name: research_pois_todo_embed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_todo_embed ON public.research_pois USING btree (id) WHERE (content_embedding IS NULL);


--
-- Name: research_pois_todo_geocode; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_todo_geocode ON public.research_pois USING btree (id) WHERE (lat IS NULL);


--
-- Name: research_pois_todo_match; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_todo_match ON public.research_pois USING btree (id) WHERE (canonical_poi_id IS NULL);


--
-- Name: research_pois_todo_normalize; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_todo_normalize ON public.research_pois USING btree (id) WHERE (name_normalized IS NULL);


--
-- Name: canonical_categories canonical_categories_parent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_categories
    ADD CONSTRAINT canonical_categories_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES public.canonical_categories(id);


--
-- Name: canonical_poi_builds canonical_poi_builds_canonical_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_builds
    ADD CONSTRAINT canonical_poi_builds_canonical_poi_id_fkey FOREIGN KEY (canonical_poi_id) REFERENCES public.canonical_pois(id) ON DELETE CASCADE;


--
-- Name: canonical_poi_builds canonical_poi_builds_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_builds
    ADD CONSTRAINT canonical_poi_builds_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.research_normalization_requests(id) ON DELETE SET NULL;


--
-- Name: canonical_poi_categories canonical_poi_categories_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_categories
    ADD CONSTRAINT canonical_poi_categories_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.canonical_categories(id) ON DELETE CASCADE;


--
-- Name: canonical_poi_categories canonical_poi_categories_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_categories
    ADD CONSTRAINT canonical_poi_categories_poi_id_fkey FOREIGN KEY (poi_id) REFERENCES public.canonical_pois(id) ON DELETE CASCADE;


--
-- Name: canonical_poi_occurrences canonical_poi_occurrences_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_occurrences
    ADD CONSTRAINT canonical_poi_occurrences_poi_id_fkey FOREIGN KEY (poi_id) REFERENCES public.canonical_pois(id) ON DELETE CASCADE;


--
-- Name: canonical_poi_redirects canonical_poi_redirects_from_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_redirects
    ADD CONSTRAINT canonical_poi_redirects_from_poi_id_fkey FOREIGN KEY (from_poi_id) REFERENCES public.canonical_pois(id) ON DELETE CASCADE;


--
-- Name: canonical_poi_redirects canonical_poi_redirects_to_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_poi_redirects
    ADD CONSTRAINT canonical_poi_redirects_to_poi_id_fkey FOREIGN KEY (to_poi_id) REFERENCES public.canonical_pois(id) ON DELETE CASCADE;


--
-- Name: canonical_pois canonical_pois_active_build_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_pois
    ADD CONSTRAINT canonical_pois_active_build_fkey FOREIGN KEY (active_build_id) REFERENCES public.canonical_poi_builds(id) ON DELETE SET NULL;


--
-- Name: canonical_pois canonical_pois_primary_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_pois
    ADD CONSTRAINT canonical_pois_primary_category_id_fkey FOREIGN KEY (primary_category_id) REFERENCES public.canonical_categories(id) ON DELETE SET NULL;


--
-- Name: research_canonical_memberships research_canonical_memberships_canonical_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_canonical_memberships
    ADD CONSTRAINT research_canonical_memberships_canonical_poi_id_fkey FOREIGN KEY (canonical_poi_id) REFERENCES public.canonical_pois(id) ON DELETE CASCADE;


--
-- Name: research_canonical_memberships research_canonical_memberships_match_decision_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_canonical_memberships
    ADD CONSTRAINT research_canonical_memberships_match_decision_id_fkey FOREIGN KEY (match_decision_id) REFERENCES public.research_match_decisions(id) ON DELETE SET NULL;


--
-- Name: research_canonical_memberships research_canonical_memberships_normalization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_canonical_memberships
    ADD CONSTRAINT research_canonical_memberships_normalization_id_fkey FOREIGN KEY (normalization_id) REFERENCES public.research_poi_normalizations(id) ON DELETE SET NULL;


--
-- Name: research_canonical_memberships research_canonical_memberships_research_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_canonical_memberships
    ADD CONSTRAINT research_canonical_memberships_research_poi_id_fkey FOREIGN KEY (research_poi_id) REFERENCES public.research_pois(id) ON DELETE CASCADE;


--
-- Name: research_consolidation_decisions research_consolidation_decisions_canonical_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_consolidation_decisions
    ADD CONSTRAINT research_consolidation_decisions_canonical_a_fkey FOREIGN KEY (canonical_a) REFERENCES public.canonical_pois(id) ON DELETE CASCADE;


--
-- Name: research_consolidation_decisions research_consolidation_decisions_canonical_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_consolidation_decisions
    ADD CONSTRAINT research_consolidation_decisions_canonical_b_fkey FOREIGN KEY (canonical_b) REFERENCES public.canonical_pois(id) ON DELETE CASCADE;


--
-- Name: research_ingest_run_records research_ingest_run_records_observation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_run_records
    ADD CONSTRAINT research_ingest_run_records_observation_fkey FOREIGN KEY (observation_id) REFERENCES public.research_poi_observations(id) ON DELETE SET NULL;


--
-- Name: research_ingest_run_records research_ingest_run_records_research_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_run_records
    ADD CONSTRAINT research_ingest_run_records_research_poi_id_fkey FOREIGN KEY (research_poi_id) REFERENCES public.research_pois(id) ON DELETE SET NULL;


--
-- Name: research_ingest_run_records research_ingest_run_records_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_run_records
    ADD CONSTRAINT research_ingest_run_records_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.research_ingest_runs(id) ON DELETE CASCADE;


--
-- Name: research_ingest_run_records research_ingest_run_records_source_file_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_run_records
    ADD CONSTRAINT research_ingest_run_records_source_file_version_id_fkey FOREIGN KEY (source_file_version_id) REFERENCES public.research_source_file_versions(id) ON DELETE CASCADE;


--
-- Name: research_ingest_runs research_ingest_runs_resumed_from_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_runs
    ADD CONSTRAINT research_ingest_runs_resumed_from_run_id_fkey FOREIGN KEY (resumed_from_run_id) REFERENCES public.research_ingest_runs(id) ON DELETE SET NULL;


--
-- Name: research_ingest_runs research_ingest_runs_source_file_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_runs
    ADD CONSTRAINT research_ingest_runs_source_file_version_id_fkey FOREIGN KEY (source_file_version_id) REFERENCES public.research_source_file_versions(id);


--
-- Name: research_ingest_runs research_ingest_runs_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_ingest_runs
    ADD CONSTRAINT research_ingest_runs_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.research_sources(id);


--
-- Name: research_match_decisions research_match_decisions_candidate_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_match_decisions
    ADD CONSTRAINT research_match_decisions_candidate_poi_id_fkey FOREIGN KEY (candidate_poi_id) REFERENCES public.canonical_pois(id) ON DELETE SET NULL;


--
-- Name: research_match_decisions research_match_decisions_research_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_match_decisions
    ADD CONSTRAINT research_match_decisions_research_id_fkey FOREIGN KEY (research_id) REFERENCES public.research_pois(id) ON DELETE CASCADE;


--
-- Name: research_match_overrides research_match_overrides_record_a_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_match_overrides
    ADD CONSTRAINT research_match_overrides_record_a_fkey FOREIGN KEY (record_a) REFERENCES public.research_pois(id) ON DELETE CASCADE;


--
-- Name: research_match_overrides research_match_overrides_record_b_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_match_overrides
    ADD CONSTRAINT research_match_overrides_record_b_fkey FOREIGN KEY (record_b) REFERENCES public.research_pois(id) ON DELETE CASCADE;


--
-- Name: research_normalization_requests research_normalization_requests_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_normalization_requests
    ADD CONSTRAINT research_normalization_requests_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES public.research_poi_observations(id) ON DELETE CASCADE;


--
-- Name: research_normalization_requests research_normalization_requests_repaired_from_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_normalization_requests
    ADD CONSTRAINT research_normalization_requests_repaired_from_id_fkey FOREIGN KEY (repaired_from_id) REFERENCES public.research_normalization_requests(id) ON DELETE SET NULL;


--
-- Name: research_normalization_requests research_normalization_requests_research_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_normalization_requests
    ADD CONSTRAINT research_normalization_requests_research_poi_id_fkey FOREIGN KEY (research_poi_id) REFERENCES public.research_pois(id) ON DELETE CASCADE;


--
-- Name: research_pipeline_jobs research_pipeline_jobs_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pipeline_jobs
    ADD CONSTRAINT research_pipeline_jobs_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.research_ingest_runs(id) ON DELETE SET NULL;


--
-- Name: research_poi_embeddings research_poi_embeddings_normalization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_embeddings
    ADD CONSTRAINT research_poi_embeddings_normalization_id_fkey FOREIGN KEY (normalization_id) REFERENCES public.research_poi_normalizations(id) ON DELETE CASCADE;


--
-- Name: research_poi_geocodes research_poi_geocodes_normalization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_geocodes
    ADD CONSTRAINT research_poi_geocodes_normalization_id_fkey FOREIGN KEY (normalization_id) REFERENCES public.research_poi_normalizations(id) ON DELETE CASCADE;


--
-- Name: research_poi_normalization_occurrences research_poi_normalization_occurrences_normalization_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_normalization_occurrences
    ADD CONSTRAINT research_poi_normalization_occurrences_normalization_id_fkey FOREIGN KEY (normalization_id) REFERENCES public.research_poi_normalizations(id) ON DELETE CASCADE;


--
-- Name: research_poi_normalizations research_poi_normalizations_observation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_normalizations
    ADD CONSTRAINT research_poi_normalizations_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES public.research_poi_observations(id) ON DELETE CASCADE;


--
-- Name: research_poi_normalizations research_poi_normalizations_request_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_normalizations
    ADD CONSTRAINT research_poi_normalizations_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.research_normalization_requests(id) ON DELETE SET NULL;


--
-- Name: research_poi_normalizations research_poi_normalizations_research_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_normalizations
    ADD CONSTRAINT research_poi_normalizations_research_poi_id_fkey FOREIGN KEY (research_poi_id) REFERENCES public.research_pois(id) ON DELETE CASCADE;


--
-- Name: research_poi_observations research_poi_observations_research_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_observations
    ADD CONSTRAINT research_poi_observations_research_poi_id_fkey FOREIGN KEY (research_poi_id) REFERENCES public.research_pois(id) ON DELETE CASCADE;


--
-- Name: research_poi_observations research_poi_observations_source_file_version_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_poi_observations
    ADD CONSTRAINT research_poi_observations_source_file_version_id_fkey FOREIGN KEY (source_file_version_id) REFERENCES public.research_source_file_versions(id) ON DELETE SET NULL;


--
-- Name: research_pois research_pois_active_normalization_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_active_normalization_fkey FOREIGN KEY (active_normalization_id) REFERENCES public.research_poi_normalizations(id) ON DELETE SET NULL;


--
-- Name: research_pois research_pois_active_observation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_active_observation_fkey FOREIGN KEY (active_observation_id) REFERENCES public.research_poi_observations(id) ON DELETE SET NULL;


--
-- Name: research_pois research_pois_canonical_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_canonical_poi_id_fkey FOREIGN KEY (canonical_poi_id) REFERENCES public.canonical_pois(id) ON DELETE SET NULL;


--
-- Name: research_pois research_pois_geocode_query_norm_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_geocode_query_norm_fkey FOREIGN KEY (geocode_query_norm) REFERENCES public.research_geocode_cache(query_norm) ON DELETE SET NULL;


--
-- Name: research_pois research_pois_matched_normalization_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_matched_normalization_fkey FOREIGN KEY (matched_normalization_id) REFERENCES public.research_poi_normalizations(id) ON DELETE SET NULL;


--
-- Name: research_pois research_pois_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.research_sources(id);


--
-- Name: research_source_file_versions research_source_file_versions_source_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_source_file_versions
    ADD CONSTRAINT research_source_file_versions_source_file_id_fkey FOREIGN KEY (source_file_id) REFERENCES public.research_source_files(id) ON DELETE CASCADE;


--
-- Name: research_source_files research_source_files_active_version_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_source_files
    ADD CONSTRAINT research_source_files_active_version_fkey FOREIGN KEY (active_version_id) REFERENCES public.research_source_file_versions(id) ON DELETE SET NULL;


--
-- Name: research_source_files research_source_files_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_source_files
    ADD CONSTRAINT research_source_files_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.research_sources(id) ON DELETE CASCADE;


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


