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
  /** Event start (ISO 8601). NULL/omitted for permanent (non-event) POIs. */
  starts_at?: string | null;
  /** Event end (ISO 8601). NULL/omitted = single-instant or unknown end. */
  ends_at?: string | null;
  /** How precisely starts_at is known: 'datetime' | 'day' | 'month' | 'year'. */
  date_precision?: string | null;
}

export interface InsertPoisOptions {
  /** If true, DELETE FROM pois before inserting. Default: false */
  replace?: boolean;
}

export interface InsertFailure {
  index: number;
  name: string;
  error: string;
}

export interface InsertPoisResult {
  inserted: number;
  failed: InsertFailure[];
}

/**
 * Insert an array of POIs into the database.
 * Attempts batch inserts for speed; falls back to row-by-row on failure
 * to identify and report individual problematic entries.
 */
export async function insertPois(
  db: Pool,
  pois: NewPoi[],
  options: InsertPoisOptions = {},
): Promise<InsertPoisResult> {
  if (pois.length === 0) return { inserted: 0, failed: [] };

  const BATCH_SIZE = 500;
  let totalInserted = 0;
  const allFailures: InsertFailure[] = [];

  if (options.replace) {
    await db.query("DELETE FROM pois");
  }

  for (let batchStart = 0; batchStart < pois.length; batchStart += BATCH_SIZE) {
    const batch = pois.slice(batchStart, batchStart + BATCH_SIZE);

    try {
      const count = await insertBatch(db, batch);
      totalInserted += count;
    } catch {
      // Batch failed — fall back to one-by-one to identify failures
      for (let j = 0; j < batch.length; j++) {
        const poi = batch[j]!;
        try {
          await insertSingle(db, poi);
          totalInserted++;
        } catch (rowErr) {
          allFailures.push({
            index: batchStart + j,
            name: poi.name,
            error: (rowErr as Error).message,
          });
        }
      }
    }
  }

  return { inserted: totalInserted, failed: allFailures };
}

const UPSERT_SUFFIX = `
ON CONFLICT (lng, lat) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  address = EXCLUDED.address,
  website = EXCLUDED.website,
  hours = EXCLUDED.hours,
  photo_url = EXCLUDED.photo_url,
  starts_at = EXCLUDED.starts_at,
  ends_at = EXCLUDED.ends_at,
  date_precision = EXCLUDED.date_precision`;

const INSERT_COLUMNS =
  "name, category, description, address, website, hours, photo_url, lng, lat, starts_at, ends_at, date_precision";

function poiParams(poi: NewPoi): (string | number | null)[] {
  return [
    poi.name,
    poi.category,
    poi.description ?? null,
    poi.address ?? null,
    poi.website ?? null,
    poi.hours ?? null,
    poi.photo_url ?? null,
    poi.lng,
    poi.lat,
    poi.starts_at ?? null,
    poi.ends_at ?? null,
    poi.date_precision ?? null,
  ];
}

const COLS_PER_ROW = 12;

async function insertBatch(db: Pool, batch: NewPoi[]): Promise<number> {
  const values: string[] = [];
  const params: (string | number | null)[] = [];
  let idx = 1;

  for (const poi of batch) {
    const placeholders = Array.from(
      { length: COLS_PER_ROW },
      (_, k) => `$${idx + k}`,
    ).join(", ");
    values.push(`(${placeholders})`);
    params.push(...poiParams(poi));
    idx += COLS_PER_ROW;
  }

  const result = await db.query(
    `INSERT INTO pois (${INSERT_COLUMNS})
     VALUES ${values.join(", ")}${UPSERT_SUFFIX}`,
    params,
  );
  return result.rowCount ?? batch.length;
}

async function insertSingle(db: Pool, poi: NewPoi): Promise<void> {
  const placeholders = Array.from(
    { length: COLS_PER_ROW },
    (_, k) => `$${k + 1}`,
  ).join(", ");
  await db.query(
    `INSERT INTO pois (${INSERT_COLUMNS})
     VALUES (${placeholders})${UPSERT_SUFFIX}`,
    poiParams(poi),
  );
}

export interface ListPoisInBboxParams {
  west: number;
  south: number;
  east: number;
  north: number;
  category: string | null;
  limit: number;
  isWorldView: boolean;
  /** Optional event-date window (ISO 8601). When both are set, events are restricted to
   *  those overlapping [from, to]; permanent POIs (starts_at IS NULL) are always included. */
  from?: string | null;
  to?: string | null;
}

// Shared GeoJSON feature properties — keep the world-view and bbox queries in sync.
const FEATURE_PROPERTIES = `jsonb_build_object(
  'id', id, 'name', name, 'category', category, 'photo_url', photo_url,
  'starts_at', starts_at, 'ends_at', ends_at, 'date_precision', date_precision
)`;

// Date-window predicate: no-op unless both bounds are provided; permanent POIs always pass.
const DATE_FILTER = (from: string, to: string) => `(
  ${from}::timestamptz IS NULL OR ${to}::timestamptz IS NULL
  OR starts_at IS NULL
  OR event_range && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[]')
)`;

export async function listPoisGeoJson(
  db: Pool,
  params: ListPoisInBboxParams,
): Promise<unknown> {
  const { west, south, east, north, category, limit, isWorldView } = params;
  const from = params.from ?? null;
  const to = params.to ?? null;

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
          'properties', ${FEATURE_PROPERTIES}
        ) AS feature
        FROM pois
        WHERE ($1::text IS NULL OR category = $1)
          AND ${DATE_FILTER("$3", "$4")}
        LIMIT $2
      ) sub`,
      [category, limit, from, to],
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
        'properties', ${FEATURE_PROPERTIES}
      ) AS feature
      FROM pois
      WHERE lng >= $1 AND lat >= $2 AND lng <= $3 AND lat <= $4
        AND ($5::text IS NULL OR category = $5)
        AND ${DATE_FILTER("$7", "$8")}
      LIMIT $6
    ) sub`,
    [west, south, east, north, category, limit, from, to],
  );

  return rows[0]?.geojson ?? { type: "FeatureCollection", features: [] };
}

export async function listPoiCategories(db: Pool): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT DISTINCT category FROM pois ORDER BY category`,
  );
  return rows.map((row) => row.category as string);
}

export async function getPoiById(db: Pool, id: string) {
  const { rows } = await db.query(
    `SELECT id, name, category, description, address, website, hours, photo_url,
            lng, lat, starts_at, ends_at, date_precision,
            CASE
              WHEN starts_at IS NULL THEN NULL
              WHEN starts_at > now() THEN 'upcoming'
              WHEN now() <= COALESCE(ends_at, starts_at) THEN 'ongoing'
              ELSE 'past'
            END AS status,
            jsonb_build_object('type', 'Point', 'coordinates', jsonb_build_array(lng, lat)) AS geometry
     FROM pois WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
