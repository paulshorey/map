-- Close lineage gaps between captured records, derived artifacts, and canonical builds.

ALTER TABLE public.research_pois
  ADD COLUMN source_record_id_kind text NOT NULL DEFAULT 'natural'
    CHECK (source_record_id_kind IN ('natural','url','synthetic')),
  ADD COLUMN identity_inputs jsonb,
  ADD COLUMN active_geocode_id uuid,
  ADD COLUMN active_embedding_id uuid;

ALTER TABLE public.research_pois
  ADD CONSTRAINT research_pois_active_geocode_fkey
    FOREIGN KEY (active_geocode_id) REFERENCES public.research_poi_geocodes(id) ON DELETE SET NULL,
  ADD CONSTRAINT research_pois_active_embedding_fkey
    FOREIGN KEY (active_embedding_id) REFERENCES public.research_poi_embeddings(id) ON DELETE SET NULL;

ALTER TABLE public.research_ingest_run_records
  DROP CONSTRAINT research_ingest_run_records_extract_state_check,
  ADD CONSTRAINT research_ingest_run_records_extract_state_check
    CHECK (extract_state IN ('pending','written','unchanged','rejected','failed','duplicate','collision'));

ALTER TABLE public.research_canonical_memberships
  ADD COLUMN run_id uuid REFERENCES public.research_ingest_runs(id) ON DELETE SET NULL;
CREATE INDEX research_canonical_memberships_run_idx
  ON public.research_canonical_memberships (run_id) WHERE run_id IS NOT NULL;

ALTER TABLE public.canonical_pois
  ADD COLUMN origin text NOT NULL DEFAULT 'research'
    CHECK (origin IN ('research','manual'));
-- Direct/legacy inserts have no active research membership and must not be auto-deleted.
UPDATE public.canonical_pois cp
SET origin = 'manual'
WHERE NOT EXISTS (
  SELECT 1 FROM public.research_canonical_memberships m
  WHERE m.canonical_poi_id = cp.id AND m.active
);

ALTER TABLE public.canonical_poi_redirects
  ADD COLUMN consolidation_decision_id uuid
    REFERENCES public.research_consolidation_decisions(id) ON DELETE SET NULL;

CREATE TABLE public.canonical_poi_build_inputs (
  build_id          uuid NOT NULL REFERENCES public.canonical_poi_builds(id) ON DELETE CASCADE,
  research_poi_id   uuid NOT NULL,
  normalization_id  uuid,
  geocode_id        uuid,
  embedding_id      uuid,
  membership_id     uuid,
  PRIMARY KEY (build_id, research_poi_id)
);
CREATE INDEX canonical_poi_build_inputs_research_idx
  ON public.canonical_poi_build_inputs (research_poi_id);
