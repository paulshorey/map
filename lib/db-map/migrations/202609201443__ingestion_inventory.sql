-- Discovery is independent of import. Never delete source evidence during inventory scans.
CREATE TABLE research_ingest_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  logical_path text NOT NULL UNIQUE CHECK (logical_path LIKE 'poi/%'),
  format text NOT NULL CHECK (format IN ('json','jsonl','csv','kml','kmz')),
  file_sha256 text,
  byte_size bigint,
  modified_at timestamptz,
  extractor_version text,
  source_slug text,
  category_slug text,
  disposition text NOT NULL DEFAULT 'needs_review' CHECK (disposition IN ('needs_review','import','alternate','supporting','ignored')),
  notes text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  scanned_at timestamptz NOT NULL DEFAULT now(),
  missing_at timestamptz,
  scan_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE research_ingest_inventory_versions (
  inventory_id uuid NOT NULL REFERENCES research_ingest_inventory(id) ON DELETE CASCADE,
  file_sha256 text NOT NULL,
  byte_size bigint NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (inventory_id,file_sha256)
);
CREATE TABLE research_ingest_inventory_edits (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inventory_id uuid NOT NULL REFERENCES research_ingest_inventory(id) ON DELETE CASCADE,
  previous jsonb NOT NULL,
  updated jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX research_ingest_run_items_observation_idx ON research_ingest_run_items(observation_id,run_id);
