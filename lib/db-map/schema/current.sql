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
    CONSTRAINT canonical_pois_date_precision_check CHECK ((date_precision = ANY (ARRAY['datetime'::text, 'day'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT canonical_pois_status_check CHECK ((status = ANY (ARRAY['published'::text, 'draft'::text, 'hidden'::text])))
);


--
-- Name: research_category_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research_category_aliases (
    alias text NOT NULL,
    category_id uuid NOT NULL,
    source_id uuid
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
    CONSTRAINT research_match_decisions_method_check CHECK ((method = ANY (ARRAY['strong_id'::text, 'auto'::text, 'llm'::text, 'override'::text])))
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
    raw jsonb NOT NULL,
    attributes jsonb,
    content_embedding real[],
    content_hash text,
    canonical_poi_id uuid,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_pois_date_precision_check CHECK ((date_precision = ANY (ARRAY['datetime'::text, 'day'::text, 'month'::text, 'year'::text])))
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
-- Name: canonical_pois canonical_pois_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_pois
    ADD CONSTRAINT canonical_pois_pkey PRIMARY KEY (id);


--
-- Name: research_geocode_cache research_geocode_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_geocode_cache
    ADD CONSTRAINT research_geocode_cache_pkey PRIMARY KEY (query_norm);


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

CREATE INDEX canonical_poi_categories_cat_idx ON public.canonical_poi_categories USING btree (category_id);


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
-- Name: canonical_pois_starts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_starts_idx ON public.canonical_pois USING btree (starts_at);


--
-- Name: canonical_pois_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_pois_status_idx ON public.canonical_pois USING btree (status);


--
-- Name: research_category_aliases_global_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX research_category_aliases_global_uq ON public.research_category_aliases USING btree (alias, category_id) WHERE (source_id IS NULL);


--
-- Name: research_category_aliases_source_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX research_category_aliases_source_uq ON public.research_category_aliases USING btree (alias, category_id, source_id) WHERE (source_id IS NOT NULL);


--
-- Name: research_match_decisions_research_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_match_decisions_research_idx ON public.research_match_decisions USING btree (research_id);


--
-- Name: research_pois_canon_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX research_pois_canon_idx ON public.research_pois USING btree (canonical_poi_id);


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
-- Name: research_category_aliases research_category_aliases_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_category_aliases
    ADD CONSTRAINT research_category_aliases_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.canonical_categories(id) ON DELETE CASCADE;


--
-- Name: research_category_aliases research_category_aliases_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_category_aliases
    ADD CONSTRAINT research_category_aliases_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.research_sources(id);


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
-- Name: research_pois research_pois_canonical_poi_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_canonical_poi_id_fkey FOREIGN KEY (canonical_poi_id) REFERENCES public.canonical_pois(id) ON DELETE SET NULL;


--
-- Name: research_pois research_pois_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research_pois
    ADD CONSTRAINT research_pois_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.research_sources(id);


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


