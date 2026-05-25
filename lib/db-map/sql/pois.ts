import type { Pool } from "pg";

export interface NewPoi {
  name: string;
  category: string;
  description?: string | null;
  address?: string | null;
  website?: string | null;
  hours?: string | null;
  photo_url?: string | null;
  lng: number;
  lat: number;
}

export interface InsertPoisOptions {
  /** If true, DELETE FROM pois before inserting. Default: false */
  replace?: boolean;
}

/**
 * Insert an array of POIs into the database in a single batch query.
 * Returns the number of rows inserted.
 */
export async function insertPois(
  db: Pool,
  pois: NewPoi[],
  options: InsertPoisOptions = {},
): Promise<number> {
  if (pois.length === 0) return 0;

  const BATCH_SIZE = 500;
  let totalInserted = 0;

  if (options.replace) {
    await db.query("DELETE FROM pois");
  }

  for (let i = 0; i < pois.length; i += BATCH_SIZE) {
    const batch = pois.slice(i, i + BATCH_SIZE);
    const values: string[] = [];
    const params: (string | number | null)[] = [];
    let idx = 1;

    for (const poi of batch) {
      values.push(
        `($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5}, $${idx + 6}, $${idx + 7}, $${idx + 8})`,
      );
      params.push(
        poi.name,
        poi.category,
        poi.description ?? null,
        poi.address ?? null,
        poi.website ?? null,
        poi.hours ?? null,
        poi.photo_url ?? null,
        poi.lng,
        poi.lat,
      );
      idx += 9;
    }

    const result = await db.query(
      `INSERT INTO pois (name, category, description, address, website, hours, photo_url, lng, lat)
       VALUES ${values.join(", ")}`,
      params,
    );
    totalInserted += result.rowCount ?? batch.length;
  }

  return totalInserted;
}

export interface ListPoisInBboxParams {
  west: number;
  south: number;
  east: number;
  north: number;
  category: string | null;
  limit: number;
  isWorldView: boolean;
}

export async function listPoisGeoJson(
  db: Pool,
  params: ListPoisInBboxParams,
): Promise<unknown> {
  const { west, south, east, north, category, limit, isWorldView } = params;

  if (isWorldView) {
    const { rows } = await db.query(
      `
      SELECT jsonb_build_object(
        'type', 'FeatureCollection',
        'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
      ) AS geojson
      FROM (
        SELECT jsonb_build_object(
          'type', 'Feature',
          'id', id,
          'geometry', jsonb_build_object(
            'type', 'Point',
            'coordinates', jsonb_build_array(lng, lat)
          ),
          'properties', jsonb_build_object(
            'id', id, 'name', name, 'category', category, 'photo_url', photo_url
          )
        ) AS feature
        FROM pois
        WHERE ($1::text IS NULL OR category = $1)
        LIMIT $2
      ) sub`,
      [category, limit],
    );
    return rows[0]?.geojson ?? { type: "FeatureCollection", features: [] };
  }

  const { rows } = await db.query(
    `
    SELECT jsonb_build_object(
      'type', 'FeatureCollection',
      'features', COALESCE(jsonb_agg(feature), '[]'::jsonb)
    ) AS geojson
    FROM (
      SELECT jsonb_build_object(
        'type', 'Feature',
        'id', id,
        'geometry', jsonb_build_object(
          'type', 'Point',
          'coordinates', jsonb_build_array(lng, lat)
        ),
        'properties', jsonb_build_object(
          'id', id, 'name', name, 'category', category, 'photo_url', photo_url
        )
      ) AS feature
      FROM pois
      WHERE lng >= $1 AND lat >= $2 AND lng <= $3 AND lat <= $4
        AND ($5::text IS NULL OR category = $5)
      LIMIT $6
    ) sub`,
    [west, south, east, north, category, limit],
  );

  return rows[0]?.geojson ?? { type: "FeatureCollection", features: [] };
}

export async function getPoiById(db: Pool, id: string) {
  const { rows } = await db.query(
    `SELECT id, name, category, description, address, website, hours, photo_url,
            lng, lat,
            jsonb_build_object('type', 'Point', 'coordinates', jsonb_build_array(lng, lat)) AS geometry
     FROM pois WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
