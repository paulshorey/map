import type { Pool } from "pg";

export interface LocationReviewOptions {
  limit: number;
  seed: string;
  source?: string;
  run?: string;
}
export interface LocationReviewRow {
  source: string;
  source_record_id: string;
  research_id: string;
  canonical_id: string;
  build_id: string;
  normalization_id: string;
  observation_id: string;
  geocode_id: string | null;
  source_file_version_id: string | null;
  logical_path: string | null;
  raw_content_hash: string;
  capture_hash: string;
  completion: Record<string, unknown>;
  stratum: string;
  captured: Record<string, unknown>;
  raw: Record<string, unknown>;
  normalized: Record<string, unknown>;
  geocode: Record<string, unknown> | null;
  canonical: Record<string, unknown>;
  projection: Record<string, unknown>;
}
export interface LocationReviewSample {
  observed_at: string;
  population: Array<{ source: string; stratum: string; records: number }>;
  rows: LocationReviewRow[];
}

/** Separate diagnostic: one bounded, read-only snapshot; no provider or worker imports. */
export async function sampleLocationReview(
  db: Pool,
  options: LocationReviewOptions,
): Promise<LocationReviewSample> {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  )
    throw new Error("Review limit must be 1–100 source/build pairs");
  if (!options.seed || options.seed.length > 100)
    throw new Error("A reproducible seed of 1–100 characters is required");
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '10s'");
    await client.query("SET LOCAL lock_timeout = '1s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '15s'");
    const { rows } = await client.query<{ sample: LocationReviewSample }>(
      `WITH completed AS MATERIALIZED (
        SELECT DISTINCT ON (r.source_id,t.source_record_id)
          r.source_id,t.source_record_id,
          t.input->>'observation_id' verified_observation_id,
          t.output->>'normalization_id' verified_normalization_id,
          r.id run_id, r.verified_at, r.options,
          t.output verify_output, t.attempt_id verify_attempt_id
        FROM research_ingest_runs r
        JOIN research_sources rs ON rs.id=r.source_id
        JOIN research_ingest_tasks t ON t.run_id=r.id
          AND t.stage='verify'
          AND t.state IN ('succeeded','reused')
        WHERE r.status='succeeded' AND r.verified_at IS NOT NULL
          AND ($1::uuid IS NULL OR r.id=$1)
          AND ($2::text IS NULL OR rs.slug=$2)
        ORDER BY r.source_id,t.source_record_id,r.verified_at DESC,r.id
      ), eligible AS MATERIALIZED (
        SELECT rs.slug source, rp.source_record_id, rp.id research_id,
          cp.id canonical_id, cp.active_build_id build_id,
          bi.normalization_id, n.observation_id, bi.geocode_id,
          c.run_id, c.verified_at, c.options run_options,
          c.verify_output, c.verify_attempt_id,
          c.verified_observation_id,c.verified_normalization_id,
          CASE
            WHEN COALESCE(g.validation->'warnings','[]') ? 'coordinate_country_conflict' THEN 3
            WHEN COALESCE(g.validation->'warnings','[]') ?| ARRAY['coordinate_region_conflict','reverse_result_too_distant'] THEN 2
            WHEN g.validation->'reverse'->>'city' IS NOT NULL AND n.city IS NOT NULL
              AND lower(trim(n.city))<>lower(trim(g.validation->'reverse'->>'city')) THEN 1
            ELSE 0 END priority,
          CASE
            WHEN COALESCE(g.validation->'warnings','[]') ?| ARRAY['coordinate_country_conflict','coordinate_region_conflict','reverse_result_too_distant']
              OR (g.validation->'reverse'->>'city' IS NOT NULL AND n.city IS NOT NULL
                AND lower(trim(n.city))<>lower(trim(g.validation->'reverse'->>'city')))
              THEN 'risk'
            WHEN g.validation->'reverse'->>'country_code' IS NULL THEN 'no_bound_reverse'
            ELSE 'baseline' END stratum
        FROM canonical_pois cp
        JOIN canonical_poi_build_inputs bi ON bi.build_id=cp.active_build_id
        JOIN research_pois rp ON rp.id=bi.research_poi_id
        JOIN research_sources rs ON rs.id=rp.source_id
        JOIN research_poi_normalizations n ON n.id=bi.normalization_id AND n.research_poi_id=rp.id
        JOIN completed c ON c.source_id=rp.source_id AND c.source_record_id=rp.source_record_id
        LEFT JOIN research_poi_geocodes g ON g.id=bi.geocode_id
        WHERE cp.status='published' AND ($2::text IS NULL OR rs.slug=$2)
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY source,stratum
          ORDER BY priority DESC,md5($3 || ':' || research_id::text || ':' || build_id::text)) slot
        FROM eligible
      ), selected AS MATERIALIZED (
        SELECT * FROM ranked ORDER BY slot,
          CASE stratum WHEN 'risk' THEN 0 WHEN 'baseline' THEN 1 ELSE 2 END,
          source, research_id, build_id LIMIT $4
      )
      SELECT jsonb_build_object(
        'observed_at',transaction_timestamp(),
        'population',COALESCE((SELECT jsonb_agg(x ORDER BY source,stratum) FROM (
          SELECT source,stratum,count(*)::int records FROM eligible GROUP BY source,stratum
        ) x),'[]'::jsonb),
        'rows',COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'source',s.source,'source_record_id',s.source_record_id,'research_id',s.research_id,
          'canonical_id',s.canonical_id,'build_id',s.build_id,
          'normalization_id',s.normalization_id,'observation_id',s.observation_id,'geocode_id',s.geocode_id,
          'source_file_version_id',o.source_file_version_id,'logical_path',sf.logical_path,
          'raw_content_hash',o.raw_content_hash,'capture_hash',o.capture_hash,
          'completion',jsonb_build_object('run_id',s.run_id,'verified_at',s.verified_at,
            'options',s.run_options,'verify_attempt_id',s.verify_attempt_id,'verify_output',s.verify_output,
            'binding',CASE WHEN s.verified_normalization_id=s.normalization_id::text THEN 'exact_normalization'
              WHEN s.verified_observation_id=s.observation_id::text THEN 'exact_observation' ELSE 'record_identity_only' END),
          'stratum',s.stratum,'captured',o.captured,'raw',o.raw,
          'normalized',jsonb_build_object('display_name',n.display_name,'description',n.description,
            'website',n.website,'address',n.address,'city',n.city,'region',n.region,
            'country_code',n.country_code,'starts_at',n.starts_at,'ends_at',n.ends_at,
            'field_evidence',n.field_evidence,'normalizer_version',n.normalizer_version),
          'geocode',CASE WHEN g.id IS NULL THEN NULL ELSE jsonb_build_object(
            'lat',g.lat,'lng',g.lng,'normalization_id',g.normalization_id,'precision',g.precision,'status',g.status,
            'provider',g.provider,'provider_version',g.provider_version,
            'query_norm',g.query_norm,'validation',g.validation,'created_at',g.created_at) END,
          'canonical',jsonb_build_object('name',cp.name,'description',cp.description,'website',cp.website,
            'lat',cp.lat,'lng',cp.lng,'address',cp.address,'attributes',cp.attributes,
            'starts_at',cp.starts_at,'ends_at',cp.ends_at,'field_provenance',cp.field_provenance),
          'projection',jsonb_build_object('lat',rp.lat,'lng',rp.lng,'country_code',rp.country_code,
            'city',rp.city,'region',rp.region,'address',rp.address,
            'active_normalization_id',rp.active_normalization_id,'active_geocode_id',rp.active_geocode_id)
        ) ORDER BY s.slot,s.stratum,s.source,s.research_id,s.build_id)
        FROM selected s
        JOIN research_poi_observations o ON o.id=s.observation_id
        JOIN research_poi_normalizations n ON n.id=s.normalization_id
        JOIN canonical_pois cp ON cp.id=s.canonical_id
        JOIN research_pois rp ON rp.id=s.research_id
        LEFT JOIN research_poi_geocodes g ON g.id=s.geocode_id
        LEFT JOIN research_source_file_versions fv ON fv.id=o.source_file_version_id
        LEFT JOIN research_source_files sf ON sf.id=fv.source_file_id),'[]'::jsonb)
      ) sample`,
      [
        options.run ?? null,
        options.source ?? null,
        options.seed,
        options.limit,
      ],
    );
    await client.query("COMMIT");
    return rows[0]!.sample;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
