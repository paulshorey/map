import { getDb, getPoiById } from '@lib/db-map';
import { NextRequest, NextResponse } from 'next/server';

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const poi = await getPoiById(getDb(), id);

  if (!poi) {
    return NextResponse.json({ error: 'POI not found' }, { status: 404 });
  }

  return NextResponse.json(poi);
}
