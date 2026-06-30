// AUTO-GENERATED FILE. DO NOT EDIT.
// Run: pnpm --filter @lib/db-map db:types:generate

export interface PoisRow {
  "id": string;
  "name": string;
  "category": string;
  "description": string | null;
  "photo_url": string | null;
  "address": string | null;
  "website": string | null;
  "hours": string | null;
  "lng": number;
  "lat": number;
  "created_at": Date;
  "starts_at": Date | null;
  "ends_at": Date | null;
  "date_precision": string | null;
  "event_range": unknown | null;
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
  "pois": PoisRow;
  "user_preferences": UserPreferencesRow;
  "users": UsersRow;
}
