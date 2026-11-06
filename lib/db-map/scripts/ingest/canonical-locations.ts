import { createHash } from "node:crypto";
/**
 * All known locations of a canonical POI: the accepted locations of every active member,
 * de-duplicated by point. Written per build to `canonical_poi_locations`; the map renders one
 * marker per row and the drawer lists them all with their provenance.
 */
import type { PoolClient } from "pg";

export interface MemberLocation {
  id: string;
  research_poi_id: string;
  source: string;
  kind: string;
  origin: string;
  role: string;
  precision: string;
  lat: number;
  lng: number;
  label: string | null;
  query?: string | null;
}

export interface CanonicalLocation {
  lat: number;
  lng: number;
  precision: string;
  specificity: "general" | "precise";
  kinds: string[];
  origins: string[];
  roles: string[];
  label: string | null;
  queries: string[];
  is_primary: boolean;
  research_location_ids: string[];
  research_poi_ids: string[];
  sources: string[];
  ordinal: number;
}

const RANK: Record<string, number> = { point: 0, city: 1, region: 2, country: 3 };
/** ~1 cm: the same stored point from several members is one location. */
const key = (lat: number, lng: number) => `${lat.toFixed(7)},${lng.toFixed(7)}`;
const uniq = (values: string[]) => [...new Set(values)].sort();

/** Group member locations by point; the primary point (the canonical's lat/lng) comes first. */
export function groupCanonicalLocations(
  members: MemberLocation[],
  primary: { lat: number; lng: number } | null,
): CanonicalLocation[] {
  const groups = new Map<string, MemberLocation[]>();
  for (const m of members) {
    const k = key(m.lat, m.lng);
    groups.set(k, [...(groups.get(k) ?? []), m]);
  }
  const primaryKey = primary ? key(primary.lat, primary.lng) : null;
  const rows = [...groups.entries()].map(([k, list]) => {
    // Deterministic representative: finest precision, then coordinates, then row id.
    const finest = [...list].sort(
      (a, b) =>
        (RANK[a.precision] ?? 9) - (RANK[b.precision] ?? 9) ||
        a.lat - b.lat ||
        a.lng - b.lng ||
        a.id.localeCompare(b.id),
    )[0]!;
    // Precise only where some member places a venue or address at point precision.
    const precise = list.some(
      (m) => m.precision === "point" && (m.role === "venue" || m.role === "address"),
    );
    return {
      lat: finest.lat,
      lng: finest.lng,
      precision: finest.precision,
      specificity: (precise ? "precise" : "general") as "precise" | "general",
      kinds: uniq(list.map((m) => m.kind)),
      origins: uniq(list.map((m) => m.origin)),
      roles: uniq(list.map((m) => m.role)),
      label: list.find((m) => m.label)?.label ?? null,
      queries: uniq(list.flatMap((m) => (m.query ? [m.query] : []))),
      is_primary: k === primaryKey,
      // Synthesized source-only points have no research location row.
      research_location_ids: uniq(list.map((m) => m.id).filter((id) => !id.startsWith("member:"))),
      research_poi_ids: uniq(list.map((m) => m.research_poi_id)),
      sources: uniq(list.map((m) => m.source)),
      ordinal: 0,
    };
  });
  rows.sort(
    (a, b) =>
      Number(b.is_primary) - Number(a.is_primary) ||
      (RANK[a.precision] ?? 9) - (RANK[b.precision] ?? 9) ||
      b.sources.length - a.sources.length ||
      a.lat - b.lat ||
      a.lng - b.lng,
  );
  rows.forEach((row, i) => (row.ordinal = i));
  return rows;
}

const PRECISIONS = new Set(["point", "city", "region", "country"]);

/**
 * The stored point of a member with no geocode artifact: supplied (or URL) coordinates only.
 * Geocode-derived points always come from an artifact, so they are never synthesized here.
 */
export function sourceOnlyLocation(m: {
  id: string;
  source_slug?: string;
  lat?: number | null;
  lng?: number | null;
  coordinate_precision?: string | null;
  coordinate_source?: string | null;
}): MemberLocation | null {
  const lat = m.lat, lng = m.lng;
  if (
    typeof lat !== "number" || typeof lng !== "number" ||
    !Number.isFinite(lat) || !Number.isFinite(lng) ||
    Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0) ||
    !["source", "url"].includes(m.coordinate_source ?? "")
  )
    return null;
  const precision = PRECISIONS.has(m.coordinate_precision ?? "") ? m.coordinate_precision! : "point";
  return {
    id: `member:${m.id}`,
    research_poi_id: m.id,
    source: m.source_slug ?? "",
    kind: "source",
    origin: m.coordinate_source === "url" ? "url_coordinates" : "source_coordinates",
    role: precision === "point" ? "venue" : precision === "city" ? "locality" : precision,
    precision,
    lat,
    lng,
    label: null,
    query: null,
  };
}

/**
 * Stable per build and point, so an idempotent rebuild keeps every `location_id` (and the map's
 * marker IDs derived from it).
 */
export function canonicalLocationId(buildId: string, lat: number, lng: number): string {
  const h = createHash("sha256").update(`${buildId}:${key(lat, lng)}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Replace a build's locations from its members' active, accepted location rows. */
export async function writeCanonicalLocations(
  client: PoolClient,
  canonicalId: string,
  buildId: string,
  members: Array<{
    id: string;
    active_geocode_id: string | null;
    source_slug?: string;
    lat?: number | null;
    lng?: number | null;
    coordinate_precision?: string | null;
    coordinate_source?: string | null;
  }>,
  primary: { lat: number; lng: number } | null,
): Promise<CanonicalLocation[]> {
  const pairs = members.filter((m) => m.active_geocode_id);
  const { rows } = await client.query<MemberLocation>(
    `SELECT l.id, l.research_poi_id, s.slug AS source, l.kind, l.origin, l.role, l.precision,
       l.lat, l.lng, l.label, l.query
     FROM research_poi_locations l
     JOIN research_pois rp ON rp.id = l.research_poi_id
     JOIN research_sources s ON s.id = rp.source_id
     WHERE l.status = 'accepted'
       AND (l.research_poi_id, l.geocode_id) IN (
         SELECT * FROM unnest($1::uuid[], $2::uuid[]))
     ORDER BY l.id`,
    [pairs.map((m) => m.id), pairs.map((m) => m.active_geocode_id)],
  );
  // A member linked before geocoding (standalone ingest:match) still maps its stored point.
  for (const m of members)
    if (!m.active_geocode_id) {
      const point = sourceOnlyLocation(m);
      if (point) rows.push(point);
    }
  const grouped = groupCanonicalLocations(rows, primary);
  await client.query("DELETE FROM canonical_poi_locations WHERE build_id = $1", [buildId]);
  for (const g of grouped)
    await client.query(
      `INSERT INTO canonical_poi_locations(id, canonical_poi_id, build_id, lat, lng, precision, specificity,
         kinds, origins, roles, label, is_primary, research_location_ids, research_poi_ids, sources, ordinal, queries)
       VALUES ($16,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$17)`,
      [
        canonicalId,
        buildId,
        g.lat,
        g.lng,
        g.precision,
        g.specificity,
        g.kinds,
        g.origins,
        g.roles,
        g.label,
        g.is_primary,
        g.research_location_ids,
        g.research_poi_ids,
        g.sources,
        g.ordinal,
        canonicalLocationId(buildId, g.lat, g.lng),
        g.queries,
      ],
    );
  return grouped;
}
