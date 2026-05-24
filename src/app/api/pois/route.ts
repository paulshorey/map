import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const bbox = searchParams.get('bbox');
  const zoom = searchParams.get('zoom');
  const category = searchParams.get('category');

  if (!bbox) {
    return NextResponse.json(
      { error: 'bbox query parameter is required' },
      { status: 400 },
    );
  }

  const parts = bbox.split(',').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return NextResponse.json(
      { error: 'bbox must be minLng,minLat,maxLng,maxLat' },
      { status: 400 },
    );
  }

  const [w, s, e, n] = parts;
  const z = Number(zoom) || 0;
  const limit = z < 6 ? 500 : 5000;

  const isWorldView = e - w > 300 || n - s > 160;

  let queryText: string;
  let queryParams: (string | number | null)[];

  if (isWorldView) {
    queryText = `
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
      ) sub`;
    queryParams = [category ?? null, limit];
  } else {
    queryText = `
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
      ) sub`;
    queryParams = [w, s, e, n, category ?? null, limit];
  }

  const { rows } = await pool.query(queryText, queryParams);

  return NextResponse.json(rows[0].geojson, {
    headers: {
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=300',
    },
  });
}
