import type { Pool } from "pg";
import { canonicalLocationsSql, coordinateEvidenceSql } from "./map-locations";

export interface NewPoi {
  name: string;
  /** Primary category — matched to an existing canonical category by display name or slug. */
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

/** Resolve a category by display name or slug. Categories are code-owned; unknown values fail. */
async function resolveCategoryId(db: Pool, category: string): Promise<string> {
  const found = await db.query(
    `SELECT id FROM canonical_categories WHERE lower(display_name) = lower($1) OR slug = $2 LIMIT 1`,
    [category, slugify(category)],
  );
  if (found.rows[0]) return found.rows[0].id as string;

  throw new Error(
    `Unknown POI category "${category}". Add it to taxonomy.ts and run ingest:taxonomy:seed first.`,
  );
}

/**
 * Direct insert of canonical POIs (used by seed + legacy JSON/KML imports).
 * Inserts the place row and links its primary category. The research → canonical
 * conflation pipeline (see poi-ingestion.md) is the path for de-duplicated bulk ingestion;
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
            starts_at, ends_at, date_precision, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual')
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
      // Keep the denormalized primary-category shortcut in sync.
      await db.query(
        `UPDATE canonical_pois SET primary_category_id = $2 WHERE id = $1`,
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
  /** `general`: only POIs flagged as a country/region/city-level location; `precise`: all
   *  others, including legacy POIs built before the flag existed. Null/omitted: all. */
  location?: PoiLocationFilter | null;
}

export type PoiLocationFilter = "general" | "precise";

// Feature properties: id, name, primary category display name, photo, popularity, event dates.
// Primary category resolves via the denormalized primary_category_id join (hot path);
// falls back to the junction lateral if it is not set.
const FEATURE_PROPERTIES = `jsonb_build_object(
  'id', p.id,
  'marker_id', p.id::text || ':' || (loc.location->>'id'),
  'location_id', loc.location->>'id',
  'location_index', loc.location_index,
  'coordinate_kind', loc.location->>'kind',
  'location_origin', loc.location->>'origin',
  'location_precision', loc.location->>'precision',
  'location_specificity', loc.location->>'specificity',
  'name', p.name,
  'category', COALESCE(pcat.display_name, (
    SELECT c.display_name FROM canonical_poi_categories pc
    JOIN canonical_categories c ON c.id = pc.category_id
    WHERE pc.poi_id = p.id ORDER BY pc.is_primary DESC, c.sort_order LIMIT 1
  )),
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
const LOCATION_FILTER = (param: string) => `(
  ${param}::text IS NULL
  OR (${param} = 'general' AND p.attributes->>'location_specificity' = 'general')
  OR (${param} = 'precise' AND p.attributes->>'location_specificity' IS DISTINCT FROM 'general')
)`;

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

  const inBbox = `(loc.location->>'lng')::float8 >= $1 AND (loc.location->>'lat')::float8 >= $2
    AND (loc.location->>'lng')::float8 <= $3 AND (loc.location->>'lat')::float8 <= $4`;
  const matching = `p.status='published'
        AND ${CATEGORY_FILTER("$5")}
        AND ${DATE_FILTER("$7", "$8")}
        AND ${LOCATION_FILTER("$10")}
        AND ($9::boolean OR (p.lng BETWEEN $1 AND $3 AND p.lat BETWEEN $2 AND $4)
          OR EXISTS (SELECT 1 FROM canonical_poi_locations l WHERE l.build_id = p.active_build_id
            AND l.lng BETWEEN $1 AND $3 AND l.lat BETWEEN $2 AND $4))`;
  // Limit entities before expanding markers: any of a POI's locations may admit it.
  // `total` counts every matching POI, so the app can report results beyond the limit.
  const { rows } = await db.query(
    `
    WITH selected AS MATERIALIZED (
      SELECT p.* FROM canonical_pois p
      WHERE ${matching}
      ORDER BY p.popularity DESC,p.id
      LIMIT $6
    )
    SELECT jsonb_build_object('type','FeatureCollection',
      'features',COALESCE(jsonb_agg(feature ORDER BY poi_id,location_index),'[]'::jsonb),
      'total',(SELECT count(*) FROM canonical_pois p WHERE ${matching}),
      'returned',(SELECT count(*) FROM selected),
      'limit',$6::int) AS geojson
    FROM (
      SELECT p.id AS poi_id,loc.location_index,jsonb_build_object(
        'type','Feature','id',p.id::text || ':' || (loc.location->>'id'),
        'geometry',jsonb_build_object('type','Point','coordinates',
          jsonb_build_array((loc.location->>'lng')::float8,(loc.location->>'lat')::float8)),
        'properties',${FEATURE_PROPERTIES}
      ) AS feature
      FROM selected p
      LEFT JOIN canonical_categories pcat ON pcat.id=p.primary_category_id
      CROSS JOIN LATERAL jsonb_array_elements(${canonicalLocationsSql()}) WITH ORDINALITY AS loc(location,location_index)
      WHERE $9::boolean OR (${inBbox})
    ) markers`,
    [
      west,
      south,
      east,
      north,
      category,
      limit,
      from,
      to,
      isWorldView,
      params.location ?? null,
    ],
  );
  return (
    rows[0]?.geojson ?? {
      type: "FeatureCollection",
      features: [],
      total: 0,
      returned: 0,
      limit,
    }
  );
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

async function getPoisByIds(db: Pool, ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT
        p.id, p.name, p.description, p.address, p.website, p.hours, p.phone, p.photo_url,
        p.lng, p.lat, p.attributes, p.popularity,
        ${canonicalLocationsSql()} AS locations,
        ${coordinateEvidenceSql()} AS coordinate_evidence,
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
        COALESCE(pcat.display_name, (
          SELECT c.display_name FROM canonical_poi_categories pc
          JOIN canonical_categories c ON c.id = pc.category_id
          WHERE pc.poi_id = p.id ORDER BY pc.is_primary DESC, c.sort_order LIMIT 1
        )) AS category,
        COALESCE((
          SELECT array_agg(DISTINCT s.name)
          FROM research_pois r JOIN research_sources s ON s.id = r.source_id
          WHERE r.canonical_poi_id = p.id
        ), ARRAY[]::text[]) AS sources,
        jsonb_build_object('type','Point','coordinates', jsonb_build_array(p.lng, p.lat)) AS geometry
     FROM canonical_pois p
     LEFT JOIN canonical_categories pcat ON pcat.id = p.primary_category_id
     WHERE p.id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

export async function getPoiById(db: Pool, id: string) {
  return (await getPoisByIds(db, [id]))[0] ?? null;
}

/** About 1 cm: markers count as the same location only when their stored points are equal. */
const COLOCATED_EPSILON_DEG = 1e-7;

export interface ColocatedPoisParams {
  /** The clicked POI; it is always first in the result. */
  id: string;
  /** Which of its locations was clicked (a location id); defaults to the first (primary). */
  location?: string | null;
  limit?: number;
}

/**
 * Every published POI with a marker at the clicked marker's exact point, clicked POI first.
 * Coarse locations (country/region/city centroids) stack many records on one point; the
 * drawer lists all of them. Filters are deliberately not applied: this is a location view.
 */
export async function getColocatedPois(db: Pool, params: ColocatedPoisParams) {
  const anchor = await getPoiById(db, params.id);
  if (!anchor) return null;
  const locations = (anchor.locations ?? []) as Array<{
    lat: number;
    lng: number;
    id: string;
  }>;
  const location =
    locations.find((l) => l.id === params.location) ?? locations[0] ?? null;
  if (!location)
    return { location: null, pois: [anchor], total: 1, truncated: false };
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);
  const e = COLOCATED_EPSILON_DEG;
  type Collection = {
    features: Array<{ properties: { id: string; name: string } }>;
    total: number;
  };
  const box = (west: number, east: number) =>
    listPoisGeoJson(db, {
      west,
      south: location.lat - e,
      east,
      north: location.lat + e,
      category: null,
      limit,
      isWorldView: false,
    }) as Promise<Collection>;
  // Near the antimeridian the window wraps: ±180 are the same meridian.
  const boxes = [box(Math.max(-180, location.lng - e), Math.min(180, location.lng + e))];
  if (location.lng + e > 180) boxes.push(box(-180, location.lng + e - 360));
  if (location.lng - e < -180) boxes.push(box(location.lng - e + 360, 180));
  const collections = await Promise.all(boxes);
  const features = collections.flatMap((c) => c.features);
  const distinct = new Set(features.map((f) => f.properties.id));
  // One POI can match both wrapped windows: count distinct POIs unless a window was truncated.
  const fc = {
    features,
    total:
      collections.length === 1
        ? collections[0]!.total
        : collections.some((c) => new Set(c.features.map((f) => f.properties.id)).size < c.total)
          ? collections.reduce((n, c) => n + c.total, 0)
          : distinct.size,
  };
  const ids = [...distinct].filter((id) => id !== anchor.id);
  const others = (await getPoisByIds(db, ids)).sort((a, b) =>
    String(a.name).localeCompare(String(b.name)),
  );
  const total = Math.max(fc.total, others.length + 1);
  return {
    location,
    pois: [anchor, ...others],
    total,
    truncated: total > others.length + 1,
  };
}
