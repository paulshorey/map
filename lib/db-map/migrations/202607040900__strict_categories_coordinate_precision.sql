-- Strict category assignment + row-local coordinate provenance for matching.

ALTER TABLE public.research_pois
  ADD COLUMN coordinate_source text CHECK (coordinate_source IN ('source','url','geocode')),
  ADD COLUMN coordinate_precision text CHECK (coordinate_precision IN ('point','city','region')),
  ADD COLUMN geocode_query_norm text REFERENCES public.research_geocode_cache(query_norm) ON DELETE SET NULL;

DROP TABLE IF EXISTS public.research_category_aliases;
