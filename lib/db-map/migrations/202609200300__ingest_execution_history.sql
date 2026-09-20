-- Preserve every execution/record attempt; existing experimental runs remain legacy history.
ALTER TABLE research_ingest_runs
  ADD COLUMN managed boolean NOT NULL DEFAULT false,
  ADD COLUMN stop_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN stop_reason text,
  ADD COLUMN verified_at timestamptz;
ALTER TABLE research_ingest_runs DROP CONSTRAINT research_ingest_runs_status_check;
ALTER TABLE research_ingest_runs ADD CONSTRAINT research_ingest_runs_status_check
  CHECK (status IN ('planned','running','paused','waiting_budget','partial','succeeded','failed','cancelled','interrupted'));

CREATE TABLE research_ingest_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES research_ingest_runs(id),
  host text NOT NULL,
  pid integer NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','paused','partial','failed','interrupted','waiting_budget')),
  options jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  stop_reason text,
  error jsonb
);
CREATE INDEX research_ingest_executions_run_idx ON research_ingest_executions(run_id, started_at DESC);

CREATE TABLE research_ingest_run_items (
  run_id uuid NOT NULL REFERENCES research_ingest_runs(id),
  source_record_id text NOT NULL,
  research_poi_id uuid REFERENCES research_pois(id) ON DELETE SET NULL,
  observation_id uuid REFERENCES research_poi_observations(id) ON DELETE SET NULL,
  source_ordinal integer NOT NULL,
  PRIMARY KEY (run_id, source_record_id)
);
CREATE INDEX research_ingest_run_items_poi_idx ON research_ingest_run_items(research_poi_id);

CREATE TABLE research_ingest_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id uuid NOT NULL REFERENCES research_ingest_executions(id),
  run_id uuid NOT NULL REFERENCES research_ingest_runs(id),
  stage text NOT NULL CHECK (stage IN ('extract','normalize','geocode','embed','match','canonical','consolidate','report','verify')),
  target_key text NOT NULL,
  research_poi_id uuid REFERENCES research_pois(id) ON DELETE SET NULL,
  source_record_id text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','reused','skipped','blocked','failed','interrupted','waiting_budget','paused')),
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX research_ingest_attempts_run_idx ON research_ingest_attempts(run_id, stage, target_key, started_at DESC);
CREATE INDEX research_ingest_attempts_recent_idx ON research_ingest_attempts(run_id, started_at DESC);
CREATE UNIQUE INDEX research_ingest_attempts_running_idx
  ON research_ingest_attempts(run_id, stage, target_key) WHERE status='running';
ALTER TABLE research_normalization_requests
  ADD COLUMN run_id uuid REFERENCES research_ingest_runs(id),
  ADD COLUMN ingest_attempt_id uuid REFERENCES research_ingest_attempts(id);
CREATE INDEX research_normalization_requests_run_idx ON research_normalization_requests(run_id, created_at DESC);
