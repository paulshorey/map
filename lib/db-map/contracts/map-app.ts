export interface PoiFeatureProperties {
  id: string;
  marker_id: string;
  location_id: string;
  location_index: number;
  coordinate_kind: string | null;
  location_origin: string | null;
  location_precision: string | null;
  location_specificity: string | null;
  name: string;
  category: string | null;
  photo_url: string | null;
  popularity: number;
  starts_at: string | null;
  ends_at: string | null;
  date_precision: string | null;
}

/** GET /api/pois. `total` counts every matching POI; `returned` POIs (up to `limit`) are
 * expanded into one marker feature per known location. */
export interface PoiListResponse {
  type: string;
  features: Array<unknown>;
  total: number;
  returned: number;
  limit: number;
}

export interface PoiPrecisionEvidenceRecord {
  version: string;
  value: string;
  derivation: string;
  provider_class: string | null;
  provider_type: string | null;
  warnings: Array<string>;
}

export interface PoiLocationRecord {
  lat: number;
  lng: number;
  origin: string;
  kind: string;
  precision: string;
  label: string | null;
  query: string | null;
  precision_evidence?: PoiPrecisionEvidenceRecord;
}

/** One known location of a POI (the union of its members' accepted locations). */
export interface PoiMapLocationRecord {
  id: string;
  lat: number;
  lng: number;
  precision: string;
  specificity: string;
  kind: string;
  kinds: Array<string>;
  origin: string;
  origins: Array<string>;
  roles: Array<string>;
  label: string | null;
  query: string | null;
  is_primary: boolean;
  sources: Array<string>;
}

export interface PoiCoordinateEvidenceRecord {
  source_coordinates: PoiLocationRecord | null;
  inferred_coordinates: PoiLocationRecord | null;
}

export interface PoiDetailRecord {
  id: string;
  name: string;
  category: string | null;
  categories: Array<string>;
  description: string | null;
  address: string | null;
  website: string | null;
  hours: string | null;
  phone: string | null;
  photo_url: string | null;
  attributes: unknown;
  popularity: number;
  sources: Array<string>;
  starts_at: string | null;
  ends_at: string | null;
  date_precision: string | null;
  status: string | null;
  lng: number;
  lat: number;
  geometry: unknown;
  locations: Array<PoiMapLocationRecord>;
  coordinate_evidence: PoiCoordinateEvidenceRecord;
}

/** GET /api/pois/[id]/colocated. `pois[0]` is the clicked POI; the rest share its marker's
 * exact point. `truncated` when `total` exceeds the POIs returned. */
export interface PoiColocatedResponse {
  location: PoiMapLocationRecord | null;
  pois: Array<PoiDetailRecord>;
  total: number;
  truncated: boolean;
}

export interface UserPreferencesRecord {
  basemapId: string | null;
  lastCenter: Array<number> | null;
  lastZoom: number | null;
}

export interface UserSessionResponse {
  id: string;
  displayName: string;
  tier: string;
  isGuest: boolean;
  allowedProviders: Array<string>;
  preferences: UserPreferencesRecord;
}

export interface UpdatePreferencesRequest {
  basemapId?: string | null;
  lastCenter?: Array<number> | null;
  lastZoom?: number | null;
}

export interface UpdatePreferencesResponse {
  ok: boolean;
}

export interface ProviderCredentialsResponse {
  apiKey: string;
}

export interface PoiCategoriesResponse {
  categories: Array<string>;
}

export interface ErrorResponse {
  error: string;
}
