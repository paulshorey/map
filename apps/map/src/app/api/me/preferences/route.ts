import {
  getDb,
  getUserPreferences,
  upsertUserPreferences,
} from '@lib/db-map';
import { resolveUserId } from '@/lib/auth';
import { NextRequest, NextResponse } from 'next/server';

export async function PATCH(request: NextRequest) {
  const userId = resolveUserId();
  const body = (await request.json()) as Record<string, unknown>;
  const current = (await getUserPreferences(getDb(), userId)) ?? {};

  const basemapId =
    'basemapId' in body
      ? (body.basemapId as string | null)
      : (current.basemap_id ?? null);
  const lastCenterLng =
    'lastCenter' in body && Array.isArray(body.lastCenter)
      ? body.lastCenter[0]
      : (current.last_center_lng ?? null);
  const lastCenterLat =
    'lastCenter' in body && Array.isArray(body.lastCenter)
      ? body.lastCenter[1]
      : (current.last_center_lat ?? null);
  const lastZoom =
    'lastZoom' in body
      ? (body.lastZoom as number | null)
      : (current.last_zoom ?? null);

  await upsertUserPreferences(getDb(), {
    userId,
    basemapId,
    lastCenterLng,
    lastCenterLat,
    lastZoom,
  });

  return NextResponse.json({ ok: true });
}
