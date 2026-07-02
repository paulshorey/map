export interface PoiFeatureProperties {
  id: string;
  name: string;
  category: string | null;
  photo_url: string | null;
  popularity: number;
  starts_at: string | null;
  ends_at: string | null;
  date_precision: string | null;
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
