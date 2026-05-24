import {
  getDb,
  getUserWithPreferences,
} from '@lib/db-map';
import { allowedProvidersForTier, resolveUserId } from '@/lib/auth';
import { NextResponse } from 'next/server';

export async function GET() {
  const userId = resolveUserId();
  const row = await getUserWithPreferences(getDb(), userId);

  if (!row) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const lastCenter =
    row.last_center_lng != null && row.last_center_lat != null
      ? [row.last_center_lng, row.last_center_lat]
      : null;

  return NextResponse.json({
    id: row.id,
    displayName: row.display_name,
    tier: row.tier,
    isGuest: row.is_guest,
    allowedProviders: allowedProvidersForTier(row.tier),
    preferences: {
      basemapId: row.basemap_id ?? null,
      lastCenter,
      lastZoom: row.last_zoom ?? null,
    },
  });
}
