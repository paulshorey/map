import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';

const FREE_PROVIDERS = [
  'openfreemap-liberty',
  'openfreemap-positron',
  'openfreemap-bright',
  'stadia-outdoors',
  'stamen-terrain',
  'alidade-satellite',
  'alidade-smooth',
  'carto-voyager',
  'carto-positron',
  'carto-dark-matter',
  'opentopomap',
];

const PREMIUM_EXTRAS = [
  'thunderforest-outdoors',
  'thunderforest-landscape',
];

function resolveUserId(_req: { headers: Record<string, string | string[] | undefined> }): string {
  // When real auth is wired, extract user ID from JWT/session cookie here.
  // For now, every request maps to the "guest" user.
  return 'guest';
}

function allowedProvidersForTier(tier: string): string[] {
  return tier === 'premium'
    ? [...FREE_PROVIDERS, ...PREMIUM_EXTRAS]
    : FREE_PROVIDERS;
}

export async function meRoutes(app: FastifyInstance) {
  app.get('/me', async (req, reply) => {
    const userId = resolveUserId(req);

    const { rows } = await pool.query(
      `SELECT u.id, u.display_name, u.tier, u.is_guest,
              p.basemap_id, p.last_center_lng, p.last_center_lat, p.last_zoom
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
       WHERE u.id = $1`,
      [userId],
    );

    if (!rows[0]) {
      return reply.code(404).send({ error: 'User not found' });
    }

    const row = rows[0];
    const lastCenter =
      row.last_center_lng != null && row.last_center_lat != null
        ? [row.last_center_lng, row.last_center_lat]
        : null;

    reply.send({
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
  });

  app.patch('/me/preferences', async (req, reply) => {
    const userId = resolveUserId(req);
    const body = req.body as Record<string, unknown>;

    // Read current preferences first
    const { rows: existing } = await pool.query(
      'SELECT * FROM user_preferences WHERE user_id = $1',
      [userId],
    );

    const current = existing[0] ?? {};

    const basemapId = 'basemapId' in body ? (body.basemapId as string | null) : (current.basemap_id ?? null);
    const lastCenterLng = 'lastCenter' in body && Array.isArray(body.lastCenter)
      ? body.lastCenter[0] : (current.last_center_lng ?? null);
    const lastCenterLat = 'lastCenter' in body && Array.isArray(body.lastCenter)
      ? body.lastCenter[1] : (current.last_center_lat ?? null);
    const lastZoom = 'lastZoom' in body ? (body.lastZoom as number | null) : (current.last_zoom ?? null);

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

    reply.send({ ok: true });
  });
}
