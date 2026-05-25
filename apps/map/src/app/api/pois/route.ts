import {
  getDb,
  listPoisGeoJson,
} from '@lib/db-map';
import { NextRequest, NextResponse } from 'next/server';

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

  const [w, s, e, n] = parts as [number, number, number, number];
  const z = Number(zoom) || 0;
  const limit = z < 6 ? 500 : 5000;
  const isWorldView = e - w > 300 || n - s > 160;

  const geojson = await listPoisGeoJson(getDb(), {
    west: w,
    south: s,
    east: e,
    north: n,
    category: category ?? null,
    limit,
    isWorldView,
  });

  return NextResponse.json(geojson, {
    headers: {
      'Cache-Control': 'public, max-age=30, stale-while-revalidate=300',
    },
  });
}
