import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const { rows } = await pool.query(
    `SELECT id, name, category, description, address, website, hours, photo_url,
            ST_X(geom::geometry) AS lng, ST_Y(geom::geometry) AS lat,
            ST_AsGeoJSON(geom::geometry, 6)::jsonb AS geometry
     FROM pois WHERE id = $1`,
    [id],
  );

  if (!rows[0]) {
    return NextResponse.json({ error: 'POI not found' }, { status: 404 });
  }

  return NextResponse.json(rows[0]);
}
