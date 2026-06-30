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



--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--



SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: pois; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pois (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    category text NOT NULL,
    description text,
    photo_url text,
    address text,
    website text,
    hours text,
    lng double precision NOT NULL,
    lat double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    starts_at timestamp with time zone,
    ends_at timestamp with time zone,
    date_precision text,
    event_range tstzrange GENERATED ALWAYS AS (
CASE
    WHEN (starts_at IS NULL) THEN NULL::tstzrange
    ELSE tstzrange(starts_at, COALESCE(ends_at, starts_at), '[]'::text)
END) STORED,
    CONSTRAINT pois_date_precision_check CHECK ((date_precision = ANY (ARRAY['datetime'::text, 'day'::text, 'month'::text, 'year'::text])))
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
-- Name: pois pois_coords_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pois
    ADD CONSTRAINT pois_coords_unique UNIQUE (lng, lat);


--
-- Name: pois pois_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pois
    ADD CONSTRAINT pois_pkey PRIMARY KEY (id);


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
-- Name: pois_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pois_category_idx ON public.pois USING btree (category);


--
-- Name: pois_event_range_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pois_event_range_gix ON public.pois USING gist (event_range);


--
-- Name: pois_starts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pois_starts_idx ON public.pois USING btree (starts_at);


--
-- Name: user_preferences user_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_preferences
    ADD CONSTRAINT user_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--


