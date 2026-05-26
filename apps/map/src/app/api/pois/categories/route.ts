import { getDb, listPoiCategories } from '@lib/db-map';
import { NextResponse } from 'next/server';

export async function GET() {
  const categories = await listPoiCategories(getDb());
  return NextResponse.json(
    { categories },
    {
      headers: {
        'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      },
    },
  );
}
