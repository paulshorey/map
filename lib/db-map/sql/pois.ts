import type { Pool } from "pg";

export interface ListPoisInBboxParams {
  west: number;
  south: number;
  east: number;
  north: number;
  category: string | null;
  limit: number;
  isWorldView: boolean;
}

export async function listPoisGeoJson(
  db: Pool,
  params: ListPoisInBboxParams,
): Promise<unknown> {
  const { west, south, east, north, category, limit, isWorldView } = params;

  if (isWorldView) {
    const { rows } = await db.query(
      `
      SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
      ) AS geojson
      FROM (
        SELECT jsonb_build_object(
          'type', 'Feature',
          'id', id,
          'geometry', ST_AsGeoJSON(geom::geometry, 6)::jsonb,
          'properties', jsonb_build_object(
            'id', id, 'name', name, 'category', category, 'photo_url', photo_url
          )
        ) AS feature
        FROM pois
        WHERE ($1::text IS NULL OR category = $1)
        LIMIT $2
      ) sub`,
      [category, limit],
    );
    return rows[0]?.geojson ?? { type: "FeatureCollection", features: [] };
  }

  const { rows } = await db.query(
    `
    SELECT jsonb_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
    ) AS geojson
    FROM (
      SELECT jsonb_build_object(
        'type', 'Feature',
        'id', id,
        'geometry', ST_AsGeoJSON(geom::geometry, 6)::jsonb,
        'properties', jsonb_build_object(
          'id', id, 'name', name, 'category', category, 'photo_url', photo_url
        )
      ) AS feature
      FROM pois
      WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)::geography
        AND ($5::text IS NULL OR category = $5)
      LIMIT $6
    ) sub`,
    [west, south, east, north, category, limit],
  );

  return rows[0]?.geojson ?? { type: "FeatureCollection", features: [] };
}

export async function getPoiById(db: Pool, id: string) {
  const { rows } = await db.query(
    `SELECT id, name, category, description, address, website, hours, photo_url,
            ST_X(geom::geometry) AS lng, ST_Y(geom::geometry) AS lat,
            ST_AsGeoJSON(geom::geometry, 6)::jsonb AS geometry
     FROM pois WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
