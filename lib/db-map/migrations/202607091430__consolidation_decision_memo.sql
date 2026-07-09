-- Memoized canonical-vs-canonical consolidation verdicts.
--
-- The consolidation sweep (`ingest:match --consolidate`) asks the LLM whether two
-- nearby same-category canonical anchors describe one real-world place. Without a
-- memo, every rerun re-asks the same "different place" questions and re-spends LLM
-- budget. This table remembers each pair verdict.
--
-- Staleness: a verdict is trusted only while both canonicals are unchanged since
-- it was decided (canonical_pois.updated_at <= decided_at). When either side is
-- rebuilt with new linked research rows, the pair is re-adjudicated.
--
-- Pairs are stored ordered (canonical_a < canonical_b) so each pair has one row.

CREATE TABLE public.research_consolidation_decisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_a  uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  canonical_b  uuid NOT NULL REFERENCES public.canonical_pois(id) ON DELETE CASCADE,
  same_place   boolean NOT NULL,
  reason       text,
  method       text NOT NULL DEFAULT 'llm' CHECK (method IN ('llm','override')),
  decided_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT research_consolidation_decisions_pair_ordered CHECK (canonical_a < canonical_b),
  CONSTRAINT research_consolidation_decisions_pair_unique UNIQUE (canonical_a, canonical_b)
);
CREATE INDEX research_consolidation_decisions_b_idx
  ON public.research_consolidation_decisions (canonical_b);
