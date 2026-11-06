-- Daily request ledger for providers with a daily quota (LocationIQ: 5,000/day on the free
-- plan, reset at 00:00 UTC). Every real request is reserved here before it is sent, so all
-- managed and standalone processes share one count; `rate_limited_at` records the provider's
-- own "Rate Limited Day" answer. Kept by ingest:purge, like the geocode query cache.
CREATE TABLE research_provider_daily_usage (
  provider text NOT NULL,
  usage_day date NOT NULL,
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  rate_limited_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, usage_day)
);
