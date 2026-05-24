export { getDb } from "./lib/db/postgres";

export { listPoisGeoJson, getPoiById } from "./sql/pois";
export {
  getUserWithPreferences,
  getUserTier,
  getUserPreferences,
  upsertUserPreferences,
} from "./sql/users";

export type {
  PoisRow,
  UsersRow,
  UserPreferencesRow,
  PostgresDbSchema,
} from "./generated/typescript/db-types";
export type {
  PoiDetailRecord,
  PoiFeatureProperties,
  ProviderCredentialsResponse,
  UpdatePreferencesRequest,
  UpdatePreferencesResponse,
  UserPreferencesRecord,
  UserSessionResponse,
  ErrorResponse,
} from "./contracts/map-app";
