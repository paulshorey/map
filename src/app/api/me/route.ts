import { NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import { allowedProvidersForTier, resolveUserId } from '@/lib/auth';

export async function GET() {
  const userId = resolveUserId();

  const { rows } = await pool.query(
    `SELECT u.id, u.display_name, u.tier, u.is_guest,
            p.basemap_id, p.last_center_lng, p.last_center_lat, p.last_zoom
     FROM users u
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );

  if (!rows[0]) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const row = rows[0];
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
