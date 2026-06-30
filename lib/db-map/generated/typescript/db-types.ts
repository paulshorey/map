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
  "starts_at": Date | null;
  "ends_at": Date | null;
  "date_precision": string | null;
  "event_range": unknown | null;
  "created_at": Date;
  "updated_at": Date;
}

export interface ResearchCategoryAliasesRow {
  "alias": string;
  "category_id": string;
  "source_id": string;
}

export interface ResearchGeocodeCacheRow {
  "query_norm": string;
  "lat": number | null;
  "lng": number | null;
  "precision": string | null;
  "provider": string | null;
  "fetched_at": Date;
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
  "raw": unknown;
  "attributes": unknown | null;
  "content_embedding": Array<number> | null;
  "content_hash": string | null;
  "canonical_poi_id": string | null;
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
  "canonical_poi_categories": CanonicalPoiCategoriesRow;
  "canonical_poi_occurrences": CanonicalPoiOccurrencesRow;
  "canonical_pois": CanonicalPoisRow;
  "research_category_aliases": ResearchCategoryAliasesRow;
  "research_geocode_cache": ResearchGeocodeCacheRow;
  "research_match_decisions": ResearchMatchDecisionsRow;
  "research_match_overrides": ResearchMatchOverridesRow;
  "research_pois": ResearchPoisRow;
  "research_sources": ResearchSourcesRow;
  "user_preferences": UserPreferencesRow;
  "users": UsersRow;
}
