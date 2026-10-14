-- Additive scheduler and operational evidence. Existing cohorts/artifacts remain intact.
ALTER TABLE research_ingest_executions ADD COLUMN host_id uuid, ADD COLUMN process_start text,
  ADD COLUMN scheduler_version integer NOT NULL DEFAULT 1;
CREATE TABLE research_ingest_tasks (
  run_id uuid NOT NULL, source_record_id text NOT NULL, stage text NOT NULL
    CHECK(stage IN ('normalize','geocode','embed','match','canonical','verify')),
  rank integer NOT NULL, state text NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending','running','succeeded','reused','skipped','quarantined','waiting_budget','paused')),
  execution_id uuid REFERENCES research_ingest_executions(id), claim_token uuid,
  attempt_id uuid REFERENCES research_ingest_attempts(id), input jsonb NOT NULL DEFAULT '{}', output jsonb,
  started_at timestamptz, finished_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(run_id,source_record_id,stage),
  FOREIGN KEY(run_id,source_record_id) REFERENCES research_ingest_run_items(run_id,source_record_id)
);
CREATE INDEX research_ingest_tasks_queue_idx ON research_ingest_tasks(run_id,stage,state,source_record_id);
CREATE INDEX research_ingest_tasks_state_idx ON research_ingest_tasks(run_id,state);
CREATE TABLE research_ingest_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid REFERENCES research_ingest_runs(id),
  source_record_id text, stage text, code text NOT NULL, scope text NOT NULL CHECK(scope IN ('record','file','source','global')),
  severity text NOT NULL CHECK(severity IN ('info','warning','blocking')), message text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}', retryable boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','excluded')),
  first_seen_at timestamptz NOT NULL DEFAULT now(), last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,source_record_id,stage,code)
);
CREATE INDEX research_ingest_issues_open_idx ON research_ingest_issues(run_id,status,last_seen_at DESC);
CREATE TABLE research_ingest_issue_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, issue_id uuid NOT NULL REFERENCES research_ingest_issues(id),
  actor text NOT NULL, action text NOT NULL CHECK(action IN ('retry','exclude','resolved')),
  reason text NOT NULL CHECK(length(trim(reason))>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE research_ingest_record_verifications (
  run_id uuid NOT NULL, source_record_id text NOT NULL, execution_id uuid NOT NULL REFERENCES research_ingest_executions(id),
  observation_id uuid NOT NULL REFERENCES research_poi_observations(id),
  output jsonb NOT NULL, pipeline_versions jsonb NOT NULL, outcome text NOT NULL CHECK(outcome IN ('ready','non_poi','operator_excluded')),
  verified_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,source_record_id),
  FOREIGN KEY(run_id,source_record_id) REFERENCES research_ingest_run_items(run_id,source_record_id)
);
CREATE TABLE research_ingest_provider_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid REFERENCES research_ingest_runs(id),
  execution_id uuid REFERENCES research_ingest_executions(id), provider text NOT NULL, operation text NOT NULL,
  model text, records integer NOT NULL DEFAULT 1, status text NOT NULL DEFAULT 'started',
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  queue_ms integer, latency_ms integer, prompt_tokens integer, cached_tokens integer,
  completion_tokens integer, reasoning_tokens integer, estimated_cost_usd numeric,
  http_status integer, quota jsonb NOT NULL DEFAULT '{}', concurrency jsonb NOT NULL DEFAULT '{}', error jsonb
);
CREATE INDEX research_ingest_provider_calls_execution_idx ON research_ingest_provider_calls(execution_id,started_at DESC);
CREATE TABLE research_ingest_provider_call_items (
  call_id uuid NOT NULL REFERENCES research_ingest_provider_calls(id), attempt_id uuid NOT NULL REFERENCES research_ingest_attempts(id),
  PRIMARY KEY(call_id,attempt_id)
);
ALTER TABLE research_normalization_requests ADD COLUMN provider_call_id uuid REFERENCES research_ingest_provider_calls(id);
CREATE TABLE research_ingest_inventory_scans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), host_id uuid NOT NULL, checkout text NOT NULL, git_commit text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed','busy')),
  discovered integer, missing integer, errors jsonb NOT NULL DEFAULT '[]', error text
);
CREATE TABLE research_ingest_quality_reviews (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), inventory_id uuid NOT NULL REFERENCES research_ingest_inventory(id),
 file_sha256 text NOT NULL, pipeline_versions jsonb NOT NULL, actor text NOT NULL,
 decision text NOT NULL CHECK(decision IN ('accepted','needs_work')), reason text NOT NULL CHECK(length(trim(reason))>0),
 sample_records text[] NOT NULL CHECK(cardinality(sample_records)>0), reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_ingest_quality_reviews_file_idx ON research_ingest_quality_reviews(inventory_id,reviewed_at DESC);
