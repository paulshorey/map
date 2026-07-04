/**
 * Shared types for the POI ingestion pipeline (M4+).
 */

/** Normalized staging shape produced by extractors before DB upsert. */
export interface RawRecord {
  source_record_id: string;
  name?: string;
  description?: string;
  /** Official site only — omit when the source has only a listing URL. */
  website?: string;
  /** Source listing/detail page (provenance, ≠ website). */
  source_url?: string;
  phone?: string;
  email?: string;
  address?: string;
  city?: string;
  region?: string;
  country_code?: string;
  lat?: number;
  lng?: number;
  raw_category?: string;
  attributes?: Record<string, unknown>;
  raw: unknown;
}

export interface Extractor {
  slug: string;
  parse(file: string): AsyncIterable<RawRecord>;
  /**
   * Optional per-source inclusion predicate. When false, the row is still stored in
   * research_pois (provenance) but tagged with attributes._is_poi = false so later
   * stages never promote it to canonical.
   */
  isPoi?(raw: unknown): boolean;
}

export interface SourceMeta {
  slug: string;
  name: string;
  homepage?: string;
  license?: string;
  attribution?: string;
  trust: number;
}

export interface SourceDefinition {
  meta: SourceMeta;
  extractor?: Extractor;
}
