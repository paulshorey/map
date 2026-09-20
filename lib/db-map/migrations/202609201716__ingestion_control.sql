-- Persistent operator gate; independent of the lifetime of a CLI or agent session.
CREATE TABLE research_ingest_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  maintenance boolean NOT NULL DEFAULT false,
  maintenance_token uuid,
  reason text,
  actor text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (maintenance = (maintenance_token IS NOT NULL))
);
INSERT INTO research_ingest_control(singleton) VALUES(true);
CREATE TABLE research_ingest_control_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action text NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
