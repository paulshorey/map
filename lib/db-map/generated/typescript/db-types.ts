// AUTO-GENERATED FILE. DO NOT EDIT.
// Run: pnpm --filter @lib/db-map db:types:generate

export interface CanonicalCategoriesRow {
  "id": string;
  "slug": string;
  "display_name": string;
  "parent_id": string | null;
  "description": string | null;
  "icon": string | null;
  "color": string | null;
  "sort_order": number;
  "is_active": boolean;
  "is_temporal": boolean;
  "created_at": Date;
}

export interface CanonicalPoiBuildsRow {
  "id": string;
  "canonical_poi_id": string;
  "input_hash": string;
  "builder_version": string;
  "status": string;
  "fields": unknown;
  "field_provenance": unknown;
  "warnings": Array<string>;
  "request_id": string | null;
  "created_at": Date;
  "activated_at": Date | null;
}

export interface CanonicalPoiCategoriesRow {
  "poi_id": string;
  "category_id": string;
  "is_primary": boolean;
}

export interface CanonicalPoiOccurrencesRow {
  "id": string;
  "poi_id": string;
  "starts_at": Date;
  "ends_at": Date | null;
  "date_precision": string | null;
  "occurrence_range": unknown | null;
}

export interface CanonicalPoiRedirectsRow {
  "from_poi_id": string;
  "to_poi_id": string;
  "reason": string;
  "created_at": Date;
}

export interface CanonicalPoisRow {
  "id": string;
  "name": string;
  "description": string | null;
  "photo_url": string | null;
  "address": string | null;
  "website": string | null;
  "hours": string | null;
  "phone": string | null;
  "lng": number;
  "lat": number;
  "attributes": unknown;
  "field_provenance": unknown;
  "popularity": number;
  "status": string;
  "primary_category_id": string | null;
  "starts_at": Date | null;
  "ends_at": Date | null;
  "date_precision": string | null;
  "event_range": unknown | null;
  "created_at": Date;
  "updated_at": Date;
  "active_build_id": string | null;
}

export interface GeoCentroidsRow {
  "id": number;
  "kind": string;
  "name": string;
  "admin1": string | null;
  "country_code": string | null;
  "population": number | null;
  "lat": number;
  "lng": number;
}

export interface ResearchCanonicalMembershipsRow {
  "id": string;
  "research_poi_id": string;
  "normalization_id": string | null;
  "canonical_poi_id": string;
  "match_decision_id": string | null;
  "matcher_version": string;
  "active": boolean;
  "assigned_at": Date;
  "retired_at": Date | null;
  "retirement_reason": string | null;
}

export interface ResearchConsolidationDecisionsRow {
  "id": string;
  "canonical_a": string;
  "canonical_b": string;
  "same_place": boolean;
  "reason": string | null;
  "method": string;
  "decided_at": Date;
}

export interface ResearchGeocodeCacheRow {
  "query_norm": string;
  "lat": number | null;
  "lng": number | null;
  "precision": string | null;
  "provider": string | null;
  "fetched_at": Date;
}

export interface ResearchIngestRunRecordsRow {
  "id": string;
  "run_id": string;
  "source_file_version_id": string;
  "source_record_id": string | null;
  "source_ordinal": number;
  "raw_hash": string | null;
  "research_poi_id": string | null;
  "observation_id": string | null;
  "extract_state": string;
  "attempts": number;
  "last_error_class": string | null;
  "last_error": string | null;
  "next_retry_at": Date | null;
  "first_attempt_at": Date | null;
  "last_attempt_at": Date | null;
  "created_at": Date;
}

export interface ResearchIngestRunsRow {
  "id": string;
  "source_file_version_id": string;
  "source_id": string;
  "category_slug": string;
  "mode": string;
  "requested_from_stage": string | null;
  "pipeline_versions": unknown;
  "options": unknown;
  "counters": unknown;
  "status": string;
  "current_stage": string | null;
  "resumed_from_run_id": string | null;
  "fatal_error": string | null;
  "resume_command": string | null;
  "started_at": Date | null;
  "heartbeat_at": Date | null;
  "stopped_at": Date | null;
  "completed_at": Date | null;
  "created_at": Date;
}

export interface ResearchMatchDecisionsRow {
  "id": string;
  "research_id": string;
  "candidate_poi_id": string | null;
  "score": number | null;
  "signals": unknown | null;
  "decision": string;
  "method": string;
  "llm_reason": string | null;
  "decided_at": Date;
}

export interface ResearchMatchOverridesRow {
  "id": string;
  "record_a": string;
  "record_b": string | null;
  "rule": string;
  "note": string | null;
  "created_at": Date;
}

export interface ResearchNormalizationRequestsRow {
  "id": string;
  "research_poi_id": string;
  "observation_id": string;
  "input_hash": string;
  "prompt_version": string;
  "schema_version": string;
  "profile_version": string;
  "examples_version": string;
  "provider": string;
  "requested_model": string;
  "returned_model": string | null;
  "status": string;
  "request_json": unknown;
  "response_json": unknown | null;
  "response_text": string | null;
  "finish_reason": string | null;
  "prompt_tokens": number | null;
  "cached_tokens": number | null;
  "completion_tokens": number | null;
  "total_tokens": number | null;
  "estimated_cost_usd": number | null;
  "latency_ms": number | null;
  "attempt": number;
  "repaired_from_id": string | null;
  "error": string | null;
  "created_at": Date;
  "completed_at": Date | null;
}

export interface ResearchPipelineJobsRow {
  "id": string;
  "run_id": string | null;
  "target_kind": string;
  "target_id": string;
  "stage": string;
  "desired_input_hash": string;
  "stage_version": string;
  "status": string;
  "claim_token": string | null;
  "lease_owner": string | null;
  "lease_expires_at": Date | null;
  "attempts": number;
  "next_retry_at": Date | null;
  "error_class": string | null;
  "error": string | null;
  "error_details": unknown | null;
  "output_artifact_id": string | null;
  "created_at": Date;
  "started_at": Date | null;
  "completed_at": Date | null;
}

export interface ResearchPoiEmbeddingsRow {
  "id": string;
  "normalization_id": string;
  "input_hash": string;
  "model": string;
  "model_version": string;
  "embedding": Array<number>;
  "created_at": Date;
  "activated_at": Date | null;
}

export interface ResearchPoiGeocodesRow {
  "id": string;
  "normalization_id": string;
  "input_hash": string;
  "query_norm": string | null;
  "provider": string;
  "provider_version": string;
  "lat": number | null;
  "lng": number | null;
  "precision": string | null;
  "status": string;
  "validation": unknown;
  "created_at": Date;
  "activated_at": Date | null;
}

export interface ResearchPoiNormalizationOccurrencesRow {
  "id": string;
  "normalization_id": string;
  "starts_at": Date;
  "ends_at": Date | null;
  "date_precision": string | null;
  "timezone": string | null;
  "edition_year": number | null;
  "derivation": string;
  "evidence": unknown;
  "confidence": number | null;
}

export interface ResearchPoiNormalizationsRow {
  "id": string;
  "research_poi_id": string;
  "observation_id": string;
  "request_id": string | null;
  "input_hash": string;
  "normalizer_version": string;
  "status": string;
  "is_poi": boolean;
  "invalid_reason": string | null;
  "entity_kind": string | null;
  "display_name": string | null;
  "match_name": string | null;
  "edition_year": number | null;
  "aliases": Array<string>;
  "description": string | null;
  "website": string | null;
  "website_domain": string | null;
  "phone": string | null;
  "email": string | null;
  "address": string | null;
  "venue": string | null;
  "city": string | null;
  "region": string | null;
  "country_code": string | null;
  "category_slugs": Array<string> | null;
  "starts_at": Date | null;
  "ends_at": Date | null;
  "date_precision": string | null;
  "attributes": unknown;
  "field_evidence": unknown;
  "model_output": unknown;
  "warnings": Array<string>;
  "match_fingerprint": string | null;
  "activated_at": Date | null;
  "created_at": Date;
}

export interface ResearchPoiObservationsRow {
  "id": string;
  "research_poi_id": string;
  "source_file_version_id": string | null;
  "raw_content_hash": string;
  "raw": unknown;
  "captured": unknown;
  "source_is_poi_hint": boolean | null;
  "redacted_paths": Array<string>;
  "first_seen_at": Date;
  "last_seen_at": Date;
}

export interface ResearchPoisRow {
  "id": string;
  "source_id": string;
  "source_record_id": string;
  "ingest_category": string | null;
  "name": string | null;
  "name_normalized": string | null;
  "description": string | null;
  "website": string | null;
  "website_domain": string | null;
  "source_url": string | null;
  "phone": string | null;
  "email": string | null;
  "address": string | null;
  "city": string | null;
  "region": string | null;
  "country_code": string | null;
  "lng": number | null;
  "lat": number | null;
  "starts_at": Date | null;
  "ends_at": Date | null;
  "date_precision": string | null;
  "raw_category": string | null;
  "category_slugs": Array<string> | null;
  "is_poi": boolean;
  "raw": unknown;
  "attributes": unknown | null;
  "content_embedding": Array<number> | null;
  "content_hash": string | null;
  "canonical_poi_id": string | null;
  "first_seen_at": Date;
  "last_seen_at": Date;
  "coordinate_source": string | null;
  "coordinate_precision": string | null;
  "geocode_query_norm": string | null;
  "active_observation_id": string | null;
  "active_normalization_id": string | null;
  "matched_normalization_id": string | null;
  "normalization_state": string;
  "normalization_input_hash": string | null;
  "normalized_at": Date | null;
  "retired_at": Date | null;
}

export interface ResearchPoisCurrentRow {
  "id": string | null;
  "source_id": string | null;
  "source_record_id": string | null;
  "ingest_category": string | null;
  "active_observation_id": string | null;
  "active_normalization_id": string | null;
  "normalization_state": string | null;
  "canonical_poi_id": string | null;
  "name": string | null;
  "name_normalized": string | null;
  "description": string | null;
  "website": string | null;
  "website_domain": string | null;
  "source_url": string | null;
  "phone": string | null;
  "email": string | null;
  "address": string | null;
  "city": string | null;
  "region": string | null;
  "country_code": string | null;
  "lng": number | null;
  "lat": number | null;
  "starts_at": Date | null;
  "ends_at": Date | null;
  "date_precision": string | null;
  "raw_category": string | null;
  "category_slugs": Array<string> | null;
  "is_poi": boolean | null;
  "raw": unknown | null;
  "attributes": unknown | null;
  "content_embedding": Array<number> | null;
  "coordinate_source": string | null;
  "coordinate_precision": string | null;
  "geocode_query_norm": string | null;
  "first_seen_at": Date | null;
  "last_seen_at": Date | null;
}

export interface ResearchSourceFileVersionsRow {
  "id": string;
  "source_file_id": string;
  "file_sha256": string;
  "byte_size": number;
  "record_count": number | null;
  "extractor_version": string;
  "status": string;
  "error": string | null;
  "created_at": Date;
  "completed_at": Date | null;
}

export interface ResearchSourceFilesRow {
  "id": string;
  "source_id": string;
  "logical_path": string;
  "category_slug": string;
  "mode": string;
  "format": string;
  "extractor_version": string;
  "active_version_id": string | null;
  "first_seen_at": Date;
  "last_seen_at": Date;
}

export interface ResearchSourcesRow {
  "id": string;
  "slug": string;
  "name": string;
  "homepage": string | null;
  "license": string | null;
  "attribution": string | null;
  "trust": number;
  "last_ingested_at": Date | null;
  "created_at": Date;
}

export interface UserPreferencesRow {
  "user_id": string;
  "basemap_id": string | null;
  "last_center_lng": number | null;
  "last_center_lat": number | null;
  "last_zoom": number | null;
  "updated_at": Date;
}

export interface UsersRow {
  "id": string;
  "display_name": string;
  "tier": string;
  "is_guest": boolean;
  "created_at": Date;
}

export interface PostgresDbSchema {
  "canonical_categories": CanonicalCategoriesRow;
  "canonical_poi_builds": CanonicalPoiBuildsRow;
  "canonical_poi_categories": CanonicalPoiCategoriesRow;
  "canonical_poi_occurrences": CanonicalPoiOccurrencesRow;
  "canonical_poi_redirects": CanonicalPoiRedirectsRow;
  "canonical_pois": CanonicalPoisRow;
  "geo_centroids": GeoCentroidsRow;
  "research_canonical_memberships": ResearchCanonicalMembershipsRow;
  "research_consolidation_decisions": ResearchConsolidationDecisionsRow;
  "research_geocode_cache": ResearchGeocodeCacheRow;
  "research_ingest_run_records": ResearchIngestRunRecordsRow;
  "research_ingest_runs": ResearchIngestRunsRow;
  "research_match_decisions": ResearchMatchDecisionsRow;
  "research_match_overrides": ResearchMatchOverridesRow;
  "research_normalization_requests": ResearchNormalizationRequestsRow;
  "research_pipeline_jobs": ResearchPipelineJobsRow;
  "research_poi_embeddings": ResearchPoiEmbeddingsRow;
  "research_poi_geocodes": ResearchPoiGeocodesRow;
  "research_poi_normalization_occurrences": ResearchPoiNormalizationOccurrencesRow;
  "research_poi_normalizations": ResearchPoiNormalizationsRow;
  "research_poi_observations": ResearchPoiObservationsRow;
  "research_pois": ResearchPoisRow;
  "research_pois_current": ResearchPoisCurrentRow;
  "research_source_file_versions": ResearchSourceFileVersionsRow;
  "research_source_files": ResearchSourceFilesRow;
  "research_sources": ResearchSourcesRow;
  "user_preferences": UserPreferencesRow;
  "users": UsersRow;
}
