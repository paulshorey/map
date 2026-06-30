import type { Pool } from "pg";

export interface NewPoi {
  name: string;
  /** Primary category — matched to a canonical category by display name or slug (created if missing). */
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
  /** If true, DELETE all canonical POIs before inserting. Default: false */
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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Resolve a category by display name or slug; create it if missing. Returns its id. */
async function resolveCategoryId(db: Pool, category: string): Promise<string> {
  const found = await db.query(
    `SELECT id FROM canonical_categories WHERE lower(display_name) = lower($1) OR slug = $2 LIMIT 1`,
    [category, slugify(category)],
  );
  if (found.rows[0]) return found.rows[0].id as string;

  const created = await db.query(
    `INSERT INTO canonical_categories (slug, display_name)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [slugify(category), category],
  );
  return created.rows[0].id as string;
}

/**
 * Direct insert of canonical POIs (used by seed + legacy JSON/KML imports).
 * Inserts the place row and links its primary category. The research → canonical
 * conflation pipeline (see .cursor/plans) is the path for de-duplicated bulk ingestion;
 * this helper is for seeding and small curated imports.
 */
export async function insertPois(
  db: Pool,
  pois: NewPoi[],
  options: InsertPoisOptions = {},
): Promise<InsertPoisResult> {
  if (options.replace) {
    await db.query("DELETE FROM canonical_pois");
  }
  if (pois.length === 0) return { inserted: 0, failed: [] };

  let inserted = 0;
  const failed: InsertFailure[] = [];

  for (let i = 0; i < pois.length; i++) {
    const poi = pois[i]!;
    try {
      const { rows } = await db.query(
        `INSERT INTO canonical_pois
           (name, description, photo_url, address, website, hours, lng, lat,
            starts_at, ends_at, date_precision)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          poi.name,
          poi.description ?? null,
          poi.photo_url ?? null,
          poi.address ?? null,
          poi.website ?? null,
          poi.hours ?? null,
          poi.lng,
          poi.lat,
          poi.starts_at ?? null,
          poi.ends_at ?? null,
          poi.date_precision ?? null,
        ],
      );
      const poiId = rows[0].id as string;
      const categoryId = await resolveCategoryId(db, poi.category);
      await db.query(
        `INSERT INTO canonical_poi_categories (poi_id, category_id, is_primary)
         VALUES ($1, $2, true)
         ON CONFLICT (poi_id, category_id) DO NOTHING`,
        [poiId, categoryId],
      );
      inserted++;
    } catch (err) {
      failed.push({ index: i, name: poi.name, error: (err as Error).message });
    }
  }

  return { inserted, failed };
}

export interface ListPoisInBboxParams {
  west: number;
  south: number;
  east: number;
  north: number;
  /** Category display name (matched to itself + descendants), or null for all. */
  category: string | null;
  limit: number;
  isWorldView: boolean;
  /** Optional event-date window (ISO 8601). When both are set, events are restricted to
   *  those overlapping [from, to]; permanent POIs (starts_at IS NULL) are always included. */
  from?: string | null;
  to?: string | null;
}

// Feature properties: id, name, primary category display name, photo, popularity, event dates.
const FEATURE_PROPERTIES = `jsonb_build_object(
  'id', p.id,
  'name', p.name,
  'category', (
    SELECT c.display_name FROM canonical_poi_categories pc
    JOIN canonical_categories c ON c.id = pc.category_id
    WHERE pc.poi_id = p.id ORDER BY pc.is_primary DESC, c.sort_order LIMIT 1
  ),
  'photo_url', p.photo_url,
  'popularity', p.popularity,
  'starts_at', p.starts_at,
  'ends_at', p.ends_at,
  'date_precision', p.date_precision
)`;

// Category filter: match POIs in the named category OR any of its descendants.
const CATEGORY_FILTER = (param: string) => `(
  ${param}::text IS NULL OR EXISTS (
    SELECT 1 FROM canonical_poi_categories pc
    WHERE pc.poi_id = p.id AND pc.category_id IN (
      WITH RECURSIVE sub AS (
        SELECT id FROM canonical_categories WHERE display_name = ${param} OR slug = ${param}
        UNION ALL
        SELECT cc.id FROM canonical_categories cc JOIN sub ON cc.parent_id = sub.id
      ) SELECT id FROM sub
    )
  )
)`;

// Date window: no-op unless both bounds provided; permanent POIs always pass.
const DATE_FILTER = (from: string, to: string) => `(
  ${from}::timestamptz IS NULL OR ${to}::timestamptz IS NULL
  OR p.starts_at IS NULL
  OR p.event_range && tstzrange(${from}::timestamptz, ${to}::timestamptz, '[]')
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
          'id', p.id,
          'geometry', jsonb_build_object('type','Point','coordinates', jsonb_build_array(p.lng, p.lat)),
          'properties', ${FEATURE_PROPERTIES}
        ) AS feature
        FROM canonical_pois p
        WHERE p.status = 'published'
          AND ${CATEGORY_FILTER("$1")}
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
        'id', p.id,
        'geometry', jsonb_build_object('type','Point','coordinates', jsonb_build_array(p.lng, p.lat)),
        'properties', ${FEATURE_PROPERTIES}
      ) AS feature
      FROM canonical_pois p
      WHERE p.status = 'published'
        AND p.lng >= $1 AND p.lat >= $2 AND p.lng <= $3 AND p.lat <= $4
        AND ${CATEGORY_FILTER("$5")}
        AND ${DATE_FILTER("$7", "$8")}
      LIMIT $6
    ) sub`,
    [west, south, east, north, category, limit, from, to],
  );

  return rows[0]?.geojson ?? { type: "FeatureCollection", features: [] };
}

export async function listPoiCategories(db: Pool): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT display_name FROM canonical_categories
     WHERE is_active AND EXISTS (
       SELECT 1 FROM canonical_poi_categories pc WHERE pc.category_id = canonical_categories.id
     )
     ORDER BY sort_order, display_name`,
  );
  return rows.map((row) => row.display_name as string);
}

export async function getPoiById(db: Pool, id: string) {
  const { rows } = await db.query(
    `SELECT
        p.id, p.name, p.description, p.address, p.website, p.hours, p.phone, p.photo_url,
        p.lng, p.lat, p.attributes, p.popularity,
        p.starts_at, p.ends_at, p.date_precision,
        CASE
          WHEN p.starts_at IS NULL THEN NULL
          WHEN p.starts_at > now() THEN 'upcoming'
          WHEN now() <= COALESCE(p.ends_at, p.starts_at) THEN 'ongoing'
          ELSE 'past'
        END AS status,
        COALESCE((
          SELECT array_agg(c.display_name ORDER BY pc.is_primary DESC, c.sort_order)
          FROM canonical_poi_categories pc
          JOIN canonical_categories c ON c.id = pc.category_id
          WHERE pc.poi_id = p.id
        ), ARRAY[]::text[]) AS categories,
        (
          SELECT c.display_name FROM canonical_poi_categories pc
          JOIN canonical_categories c ON c.id = pc.category_id
          WHERE pc.poi_id = p.id ORDER BY pc.is_primary DESC, c.sort_order LIMIT 1
        ) AS category,
        COALESCE((
          SELECT array_agg(DISTINCT s.name)
          FROM research_pois r JOIN research_sources s ON s.id = r.source_id
          WHERE r.canonical_poi_id = p.id
        ), ARRAY[]::text[]) AS sources,
        jsonb_build_object('type','Point','coordinates', jsonb_build_array(p.lng, p.lat)) AS geometry
     FROM canonical_pois p
     WHERE p.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
