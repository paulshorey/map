-- Multi-category ingest: store the full developer-declared category set per research row,
-- source file, and run. The existing scalar columns (ingest_category, category_slug) remain
-- the primary (first) category for backward-compatible reads; the new *_categories/_slugs
-- arrays carry the complete set. Category is always developer-supplied, never inferred.

ALTER TABLE public.research_pois
  ADD COLUMN ingest_categories text[] NOT NULL DEFAULT '{}';

UPDATE public.research_pois
  SET ingest_categories = ARRAY[ingest_category]
  WHERE ingest_category IS NOT NULL AND cardinality(ingest_categories) = 0;

CREATE INDEX research_pois_ingest_categories_gix
  ON public.research_pois USING gin (ingest_categories);

ALTER TABLE public.research_source_files
  ADD COLUMN category_slugs text[] NOT NULL DEFAULT '{}';

UPDATE public.research_source_files
  SET category_slugs = ARRAY[category_slug]
  WHERE category_slug IS NOT NULL AND cardinality(category_slugs) = 0;

ALTER TABLE public.research_ingest_runs
  ADD COLUMN category_slugs text[] NOT NULL DEFAULT '{}';

UPDATE public.research_ingest_runs
  SET category_slugs = ARRAY[category_slug]
  WHERE category_slug IS NOT NULL AND cardinality(category_slugs) = 0;
