-- Preserve inventory rows from the former capture location while accepting the current tree.
ALTER TABLE research_ingest_inventory
  DROP CONSTRAINT research_ingest_inventory_logical_path_check;
ALTER TABLE research_ingest_inventory
  ADD CONSTRAINT research_ingest_inventory_logical_path_check
  CHECK (logical_path LIKE 'docs/poi/%' OR logical_path LIKE 'poi/%' OR logical_path LIKE 'data/poi/%');
