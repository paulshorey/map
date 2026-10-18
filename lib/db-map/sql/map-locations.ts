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
