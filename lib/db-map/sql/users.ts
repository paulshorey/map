import type { Pool } from "pg";

export async function getUserWithPreferences(db: Pool, userId: string) {
  const { rows } = await db.query(
    `SELECT u.id, u.display_name, u.tier, u.is_guest,
            p.basemap_id, p.last_center_lng, p.last_center_lat, p.last_zoom
     FROM users u
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function getUserTier(db: Pool, userId: string) {
  const { rows } = await db.query(
    "SELECT tier FROM users WHERE id = $1",
    [userId],
  );
  return rows[0]?.tier ?? null;
}

export interface UpsertUserPreferencesInput {
  userId: string;
  basemapId: string | null;
  lastCenterLng: number | null;
  lastCenterLat: number | null;
  lastZoom: number | null;
}

export async function upsertUserPreferences(
  db: Pool,
  input: UpsertUserPreferencesInput,
) {
  const { userId, basemapId, lastCenterLng, lastCenterLat, lastZoom } = input;

  await db.query(
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
}

export async function getUserPreferences(db: Pool, userId: string) {
  const { rows } = await db.query(
    "SELECT * FROM user_preferences WHERE user_id = $1",
    [userId],
  );
  return rows[0] ?? null;
}
