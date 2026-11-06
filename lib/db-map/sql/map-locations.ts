/** Fixed evidence buckets. Unknown legacy coordinates never become source evidence. */
export function coordinateEvidenceSql(alias = "p"): string {
  const evidence = `${alias}.attributes->'coordinate_evidence'`;
  const source = `(${evidence}->'source_coordinates')`,
    inferred = `(${evidence}->'inferred_coordinates')`;
  const valid = (
    p: string,
    kind: string,
    origin: string,
  ) => `CASE WHEN jsonb_typeof(${p}->'lat')='number'
    AND jsonb_typeof(${p}->'lng')='number' AND ${p}->>'kind'='${kind}' AND ${p}->>'origin'='${origin}'
    THEN (${p}->>'lat')::numeric BETWEEN -90 AND 90 AND (${p}->>'lng')::numeric BETWEEN -180 AND 180
      AND NOT ((${p}->>'lat')::numeric=0 AND (${p}->>'lng')::numeric=0) ELSE false END`;
  const src = `CASE WHEN ${valid(source, "source", "source_coordinates")} THEN ${source} ELSE null END`;
  const inf = `CASE WHEN ${valid(inferred, "inferred", "listed_address_geocode")} THEN ${inferred} ELSE null END`;
  const matches = (p: string) =>
    `(${p})->'lat'=to_jsonb(${alias}.lat) AND (${p})->'lng'=to_jsonb(${alias}.lng)`;
  return `CASE WHEN (${matches(src)}) OR (${matches(inf)}) THEN
    jsonb_build_object('source_coordinates',${src},'inferred_coordinates',${inf})
    ELSE jsonb_build_object('source_coordinates',null,'inferred_coordinates',null) END`;
}

/** Both evidence values survive equality; only duplicate rendered markers collapse. */
export function mapLocationsSql(alias = "p"): string {
  const evidence = coordinateEvidenceSql(alias);
  return `(SELECT CASE WHEN e->'source_coordinates' <> 'null'::jsonb OR e->'inferred_coordinates' <> 'null'::jsonb THEN
    (CASE WHEN e->'source_coordinates' <> 'null'::jsonb THEN jsonb_build_array(e->'source_coordinates') ELSE '[]'::jsonb END)
    || (CASE WHEN e->'inferred_coordinates' <> 'null'::jsonb
      AND NOT COALESCE(e->'inferred_coordinates'->'lat'=e->'source_coordinates'->'lat'
        AND e->'inferred_coordinates'->'lng'=e->'source_coordinates'->'lng',false)
      THEN jsonb_build_array(e->'inferred_coordinates') ELSE '[]'::jsonb END)
    ELSE jsonb_build_array(jsonb_build_object('lat',${alias}.lat,'lng',${alias}.lng,
      'kind','legacy','origin',CASE WHEN ${alias}.field_provenance->>'coordinate_source'='geocode' THEN 'geocode' ELSE 'legacy_coordinates' END,'precision',COALESCE(${alias}.field_provenance->>'coordinate_precision','point'),
      'label',null,'query',null)) END FROM (SELECT ${evidence} AS e) named_coordinates)`;
}

/**
 * Every known location of a canonical POI (its active build's `canonical_poi_locations`), the
 * primary point first. A POI without stored locations (manual or legacy) falls back to its one
 * stored point. Each object keeps the PoiLocationRecord fields (`kind`, `origin`, `precision`,
 * `label`, `query`) plus `id`, `specificity`, all merged `kinds`/`origins`/`roles`, and `sources`.
 */
export function canonicalLocationsSql(alias = "p"): string {
  return `(SELECT COALESCE(
    (SELECT jsonb_agg(jsonb_build_object(
        'id', l.id::text, 'lat', l.lat, 'lng', l.lng, 'precision', l.precision,
        'specificity', l.specificity, 'kind', l.kinds[1], 'kinds', to_jsonb(l.kinds),
        'origin', l.origins[1], 'origins', to_jsonb(l.origins), 'roles', to_jsonb(l.roles),
        'label', l.label, 'query', l.queries[1], 'queries', to_jsonb(l.queries),
        'is_primary', l.is_primary, 'sources', to_jsonb(l.sources))
      ORDER BY l.ordinal)
     FROM canonical_poi_locations l WHERE l.build_id = ${alias}.active_build_id),
    jsonb_build_array(jsonb_build_object(
      'id', 'legacy', 'lat', ${alias}.lat, 'lng', ${alias}.lng,
      'precision', COALESCE(${alias}.field_provenance->>'coordinate_precision', 'point'),
      'specificity', CASE WHEN ${alias}.attributes->>'location_specificity' = 'general' THEN 'general' ELSE 'precise' END,
      'kind', 'legacy', 'kinds', '["legacy"]'::jsonb,
      'origin', CASE WHEN ${alias}.field_provenance->>'coordinate_source' = 'geocode' THEN 'geocode' ELSE 'legacy_coordinates' END,
      'origins', '[]'::jsonb, 'roles', '[]'::jsonb, 'label', NULL, 'query', NULL, 'queries', '[]'::jsonb,
      'is_primary', true, 'sources', '[]'::jsonb))))`;
}
