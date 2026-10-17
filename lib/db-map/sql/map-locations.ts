/** Shared list/detail projection. Legacy POIs always retain their existing primary point. */
export function mapLocationsSql(alias = "p"): string {
  const points = `${alias}.attributes->'map_locations'`;
  const first = `(${points}->0)`;
  const second = `(${points}->1)`;
  // CASE protects casts from arbitrary legacy JSON. Bound numeric before casting to float8.
  const valid = (
    p: string,
  ) => `CASE WHEN jsonb_typeof(${p}->'lat')='number' AND jsonb_typeof(${p}->'lng')='number'
    THEN (${p}->>'lat')::numeric BETWEEN -90 AND 90 AND (${p}->>'lng')::numeric BETWEEN -180 AND 180
      AND NOT ((${p}->>'lat')::numeric=0 AND (${p}->>'lng')::numeric=0) ELSE false END`;
  const bound = `${first}->'lat'=to_jsonb(${alias}.lat) AND ${first}->'lng'=to_jsonb(${alias}.lng)`;
  return `(jsonb_build_array(CASE WHEN ${bound} THEN ${first} ELSE
    jsonb_build_object('lat',${alias}.lat,'lng',${alias}.lng,'origin','legacy_coordinates','role','primary','precision',
      COALESCE(${alias}.field_provenance->>'coordinate_precision','point'),'label',null,'query',null) END)
    || CASE WHEN ${bound} AND (${valid(second)})
      AND NOT (${second}->'lat'=${first}->'lat' AND ${second}->'lng'=${first}->'lng')
      THEN jsonb_build_array(${second}) ELSE '[]'::jsonb END)`;
}
