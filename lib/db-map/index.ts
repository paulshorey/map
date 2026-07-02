export { getDb } from "./lib/db/postgres";

export {
  listPoisGeoJson,
  listPoiCategories,
  getPoiById,
  insertPois,
} from "./sql/pois";
export type { NewPoi, InsertPoisOptions, InsertPoisResult, InsertFailure } from "./sql/pois";
export {
  getUserWithPreferences,
  getUserTier,
  getUserPreferences,
  upsertUserPreferences,
} from "./sql/users";

export type {
  CanonicalPoisRow,
  CanonicalCategoriesRow,
  CanonicalPoiCategoriesRow,
  CanonicalPoiOccurrencesRow,
  ResearchPoisRow,
  ResearchSourcesRow,
  ResearchCategoryAliasesRow,
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
  PoiCategoriesResponse,
  ErrorResponse,
} from "./contracts/map-app";
