-- Bounded recent-call snapshots must not scan every historic provider call as the backlog grows.
CREATE INDEX research_ingest_provider_calls_run_recent_idx ON research_ingest_provider_calls(run_id,started_at DESC);
CREATE INDEX research_ingest_inventory_scans_recent_idx ON research_ingest_inventory_scans(started_at DESC);
