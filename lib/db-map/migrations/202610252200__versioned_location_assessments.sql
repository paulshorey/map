-- Additive only: no historical assessment or publication backfill.
CREATE TABLE public.research_poi_location_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  research_poi_id uuid NOT NULL REFERENCES public.research_pois(id) ON DELETE CASCADE,
  observation_id uuid NOT NULL REFERENCES public.research_poi_observations(id) ON DELETE CASCADE,
  normalization_id uuid NOT NULL REFERENCES public.research_poi_normalizations(id) ON DELETE CASCADE,
  geocode_id uuid REFERENCES public.research_poi_geocodes(id) ON DELETE CASCADE,
  policy_version text NOT NULL,
  input_hash text NOT NULL,
  input_snapshot jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','needs_review','unlocated')),
  accepted_kind text CHECK (accepted_kind IN ('source','inferred')),
  accepted_point jsonb,
  reasons text[] NOT NULL,
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(research_poi_id,policy_version,input_hash),
  CHECK ((status='accepted' AND accepted_kind IS NOT NULL AND accepted_point IS NOT NULL)
    OR (status<>'accepted' AND accepted_kind IS NULL AND accepted_point IS NULL))
);
CREATE INDEX research_location_assessments_history_idx ON public.research_poi_location_assessments(research_poi_id,created_at DESC);
CREATE FUNCTION public.reject_location_assessment_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Location assessments are immutable; append a new version instead' USING ERRCODE = '23000';
END;
$$;
CREATE TRIGGER location_assessment_immutable BEFORE UPDATE ON public.research_poi_location_assessments
  FOR EACH ROW EXECUTE FUNCTION public.reject_location_assessment_update();
ALTER TABLE public.research_pois ADD COLUMN active_location_assessment_id uuid REFERENCES public.research_poi_location_assessments(id) ON DELETE SET NULL;
ALTER TABLE public.canonical_poi_build_inputs ADD COLUMN location_assessment_id uuid REFERENCES public.research_poi_location_assessments(id) ON DELETE SET NULL;
COMMENT ON TABLE public.research_poi_location_assessments IS 'Append-only policy assessments bound to exact observation, normalization, geocode and projection inputs. Accepted means usable discovery point, not verified venue or edition.';
