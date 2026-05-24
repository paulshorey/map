import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { resolveUserId } from '@/lib/auth';

export async function PATCH(request: NextRequest) {
  const userId = resolveUserId();
  const body = (await request.json()) as Record<string, unknown>;

  const { rows: existing } = await pool.query(
    'SELECT * FROM user_preferences WHERE user_id = $1',
    [userId],
  );

  const current = existing[0] ?? {};

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

  await pool.query(
    `INSERT INTO user_preferences (user_id, basemap_id, last_center_lng, last_center_lat, last_zoom, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id) DO UPDATE SET
       basemap_id = $2,
       last_center_lng = $3,
       last_center_lat = $4,
       last_zoom = $5,
       updated_at = now()`,
    [userId, basemapId, lastCenterLng, lastCenterLat, lastZoom],
  );

  return NextResponse.json({ ok: true });
}
