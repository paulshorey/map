import type { PoolClient } from "pg";
import { chat } from "./providers/deepinfra.js";
import { normalizeComparable } from "./match/text.js";

interface MergeRow {
  id: string;
  source_id: string;
  source_slug: string;
  source_trust: number;
  name: string | null;
  description: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  lng: number | null;
  lat: number | null;
  coordinate_precision: string | null;
  hours: string | null;
  photo_url: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  date_precision: string | null;
  category_slugs: string[] | null;
  attributes: Record<string, unknown> | null;
}

interface FieldChoice<T> {
  value: T | null;
  row: MergeRow | null;
}

interface OccurrenceChoice {
  starts_at: Date;
  ends_at: Date | null;
  date_precision: string | null;
  row: MergeRow;
}

export interface RebuildOptions {
  noLlm: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function provenance(row: MergeRow | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    source: row.source_slug,
    source_id: row.source_id,
    research_id: row.id,
  };
}

function chooseText(
  rows: MergeRow[],
  getter: (row: MergeRow) => string | null,
  opts: { preferLonger?: boolean; preferShorter?: boolean } = {},
): FieldChoice<string> {
  const candidates = rows
    .map((row) => ({ row, value: nonEmpty(getter(row)) }))
    .filter((c): c is { row: MergeRow; value: string } => c.value !== null)
    .sort((a, b) => {
      const trust = b.row.source_trust - a.row.source_trust;
      if (trust !== 0) return trust;
      if (opts.preferShorter) return a.value.length - b.value.length;
      if (opts.preferLonger) return b.value.length - a.value.length;
      return 0;
    });
  return { value: candidates[0]?.value ?? null, row: candidates[0]?.row ?? null };
}

function coordinateRank(value: string | null): number {
  if (value === "point") return 3;
  if (value === null) return 2;
  if (value === "city") return 1;
  return 0;
}

function chooseCoordinates(rows: MergeRow[]): FieldChoice<{ lat: number; lng: number }> {
  const candidates = rows
    .filter((row) => row.lat !== null && row.lng !== null)
    .sort((a, b) => {
      const precision = coordinateRank(b.coordinate_precision) - coordinateRank(a.coordinate_precision);
      if (precision !== 0) return precision;
      return b.source_trust - a.source_trust;
    });
  const row = candidates[0] ?? null;
  return {
    value: row && row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
    row,
  };
}

function extractUrls(value: string): Set<string> {
  return new Set(value.match(/https?:\/\/[^\s)]+/g) ?? []);
}

function descriptionFallback(rows: MergeRow[]): FieldChoice<string> {
  return chooseText(rows, (row) => row.description, { preferLonger: true });
}

async function chooseDescription(
  rows: MergeRow[],
  noLlm: boolean,
): Promise<{ value: string | null; provenance: Record<string, unknown> | null }> {
  const descriptions = rows
    .map((row) => ({ row, value: nonEmpty(row.description) }))
    .filter((d): d is { row: MergeRow; value: string } => d.value !== null);
  if (descriptions.length === 0) return { value: null, provenance: null };

  const unique = new Map<string, { row: MergeRow; value: string }>();
  for (const d of descriptions) {
    unique.set(normalizeComparable(d.value), d);
  }
  if (unique.size === 1) {
    const only = descriptions.sort((a, b) => b.row.source_trust - a.row.source_trust)[0]!;
    return { value: only.value, provenance: provenance(only.row) };
  }

  if (noLlm) {
    const fallback = descriptionFallback(rows);
    return { value: fallback.value, provenance: provenance(fallback.row) };
  }

  const allowedUrls = new Set<string>();
  for (const d of descriptions) {
    for (const url of extractUrls(d.value)) allowedUrls.add(url);
  }

  try {
    const fused = await chat({
      system:
        "Combine multiple source descriptions for one POI into concise factual Markdown. Preserve useful links and basic formatting. Do not invent details or URLs.",
      user: JSON.stringify({
        descriptions: descriptions.map((d) => ({
          source: d.row.source_slug,
          text: d.value,
        })),
      }),
      maxTokens: 700,
    });
    const introduced = [...extractUrls(fused)].filter((url) => !allowedUrls.has(url));
    if (introduced.length === 0 && fused.trim().length > 0) {
      return {
        value: fused.trim(),
        provenance: {
          source: "llm_fusion",
          research_ids: descriptions.map((d) => d.row.id),
          source_ids: descriptions.map((d) => d.row.source_id),
          sources: descriptions.map((d) => d.row.source_slug),
        },
      };
    }
  } catch (err) {
    console.warn(`Description fusion failed; using verbatim fallback: ${(err as Error).message}`);
  }

  const fallback = descriptionFallback(rows);
  return { value: fallback.value, provenance: provenance(fallback.row) };
}

function mergeAttributes(rows: MergeRow[]): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  const ordered = [...rows].sort((a, b) => a.source_trust - b.source_trust);
  for (const row of ordered) {
    const attrs = asRecord(row.attributes);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || key.startsWith("_")) continue;
      if (Array.isArray(value)) {
        const current = Array.isArray(merged[key]) ? (merged[key] as unknown[]) : [];
        merged[key] = [...new Set([...current, ...value])];
      } else if (typeof value === "object" && !Array.isArray(value)) {
        merged[key] = { ...asRecord(merged[key]), ...asRecord(value) };
      } else {
        merged[key] = value;
      }
    }
  }
  return merged;
}

async function syncCategories(
  client: PoolClient,
  canonicalId: string,
  rows: MergeRow[],
): Promise<string | null> {
  const slugs = [...new Set(rows.flatMap((row) => row.category_slugs ?? []))];
  await client.query(`DELETE FROM canonical_poi_categories WHERE poi_id = $1`, [canonicalId]);
  if (slugs.length === 0) return null;

  const { rows: categories } = await client.query<{
    id: string;
    slug: string;
    sort_order: number;
  }>(
    `SELECT id, slug, sort_order
     FROM canonical_categories
     WHERE slug = ANY($1)
     ORDER BY sort_order, display_name`,
    [slugs],
  );
  if (categories.length === 0) return null;

  const bestRow = [...rows].sort((a, b) => b.source_trust - a.source_trust)[0];
  const preferredSlug = bestRow?.category_slugs?.find((slug) => categories.some((c) => c.slug === slug));
  const primary = categories.find((c) => c.slug === preferredSlug) ?? categories[0]!;

  for (const category of categories) {
    await client.query(
      `INSERT INTO canonical_poi_categories (poi_id, category_id, is_primary)
       VALUES ($1, $2, $3)
       ON CONFLICT (poi_id, category_id) DO UPDATE SET is_primary = EXCLUDED.is_primary`,
      [canonicalId, category.id, category.id === primary.id],
    );
  }

  return primary.id;
}

function validDate(value: Date | null): Date | null {
  return value && !Number.isNaN(value.getTime()) ? value : null;
}

function occurrenceFromRow(row: MergeRow): OccurrenceChoice | null {
  const start = validDate(row.starts_at);
  if (!start) return null;
  const parsedEnd = validDate(row.ends_at);
  return {
    starts_at: start,
    ends_at: parsedEnd && parsedEnd >= start ? parsedEnd : null,
    date_precision: row.date_precision,
    row,
  };
}

function buildOccurrences(rows: MergeRow[]): OccurrenceChoice[] {
  const byStart = new Map<number, OccurrenceChoice>();
  for (const row of rows) {
    const occurrence = occurrenceFromRow(row);
    if (!occurrence) continue;
    const key = occurrence.starts_at.getTime();
    const existing = byStart.get(key);
    if (!existing || row.source_trust > existing.row.source_trust) {
      byStart.set(key, occurrence);
    }
  }

  return [...byStart.values()].sort(
    (a, b) => a.starts_at.getTime() - b.starts_at.getTime() || b.row.source_trust - a.row.source_trust,
  );
}

function chooseRepresentativeOccurrence(occurrences: OccurrenceChoice[]): OccurrenceChoice | null {
  if (occurrences.length === 0) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const activeOrUpcoming = occurrences
    .filter((occurrence) => (occurrence.ends_at ?? occurrence.starts_at).getTime() >= todayUtc)
    .sort((a, b) => a.starts_at.getTime() - b.starts_at.getTime() || b.row.source_trust - a.row.source_trust);
  if (activeOrUpcoming[0]) return activeOrUpcoming[0];

  return [...occurrences].sort(
    (a, b) => b.starts_at.getTime() - a.starts_at.getTime() || b.row.source_trust - a.row.source_trust,
  )[0]!;
}

async function syncOccurrences(
  client: PoolClient,
  canonicalId: string,
  rows: MergeRow[],
): Promise<OccurrenceChoice[]> {
  const occurrences = buildOccurrences(rows);
  await client.query(`DELETE FROM canonical_poi_occurrences WHERE poi_id = $1`, [canonicalId]);
  for (const occurrence of occurrences) {
    await client.query(
      `INSERT INTO canonical_poi_occurrences (poi_id, starts_at, ends_at, date_precision)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (poi_id, starts_at)
       DO UPDATE SET ends_at = EXCLUDED.ends_at, date_precision = EXCLUDED.date_precision`,
      [
        canonicalId,
        occurrence.starts_at,
        occurrence.ends_at,
        occurrence.date_precision,
      ],
    );
  }
  return occurrences;
}

export async function rebuildCanonicalPoi(
  client: PoolClient,
  canonicalId: string,
  opts: RebuildOptions,
): Promise<void> {
  const { rows } = await client.query<MergeRow>(
    `SELECT
       rp.id, rp.source_id, rs.slug AS source_slug, rs.trust AS source_trust,
       rp.name, rp.description, rp.website, rp.phone, rp.address,
       rp.lng, rp.lat, rp.coordinate_precision,
       COALESCE(rp.attributes->>'opening_hours', rp.attributes->>'hours') AS hours,
       COALESCE(rp.attributes->>'photo_url', rp.attributes->>'image') AS photo_url,
       rp.starts_at, rp.ends_at, rp.date_precision,
       rp.category_slugs, rp.attributes
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE rp.canonical_poi_id = $1 AND rp.is_poi
     ORDER BY rs.trust DESC, rp.last_seen_at DESC`,
    [canonicalId],
  );

  if (rows.length === 0) {
    await client.query(`DELETE FROM canonical_poi_occurrences WHERE poi_id = $1`, [canonicalId]);
    await client.query(`UPDATE canonical_pois SET status = 'hidden', updated_at = now() WHERE id = $1`, [
      canonicalId,
    ]);
    return;
  }

  const name = chooseText(rows, (row) => row.name, { preferShorter: true });
  const description = await chooseDescription(rows, opts.noLlm);
  const website = chooseText(rows, (row) => row.website);
  const phone = chooseText(rows, (row) => row.phone);
  const address = chooseText(rows, (row) => row.address, { preferLonger: true });
  const hours = chooseText(rows, (row) => row.hours);
  const photo = chooseText(rows, (row) => row.photo_url);
  const coords = chooseCoordinates(rows);
  const occurrences = await syncOccurrences(client, canonicalId, rows);
  const dates = chooseRepresentativeOccurrence(occurrences);
  const primaryCategoryId = await syncCategories(client, canonicalId, rows);
  const popularity = new Set(rows.map((row) => row.source_id)).size;
  const attributes = mergeAttributes(rows);

  const fieldProvenance = {
    name: provenance(name.row),
    description: description.provenance,
    website: provenance(website.row),
    phone: provenance(phone.row),
    address: provenance(address.row),
    hours: provenance(hours.row),
    photo_url: provenance(photo.row),
    coordinates: provenance(coords.row),
    starts_at: provenance(dates?.row ?? null),
    occurrences: {
      count: occurrences.length,
      research_ids: occurrences.map((occurrence) => occurrence.row.id),
      sources: [...new Set(occurrences.map((occurrence) => occurrence.row.source_slug))],
    },
    attributes: {
      sources: [...new Set(rows.map((row) => row.source_slug))],
      research_ids: rows.map((row) => row.id),
    },
  };

  const finalName = name.value ?? rows[0]!.id;
  const finalCoords = coords.value;
  if (!finalCoords) {
    await client.query(
      `UPDATE canonical_pois
       SET name = $2, status = 'hidden', popularity = $3, field_provenance = $4::jsonb,
           updated_at = now()
       WHERE id = $1`,
      [canonicalId, finalName, popularity, JSON.stringify(fieldProvenance)],
    );
    return;
  }

  await client.query(
    `UPDATE canonical_pois SET
       name = $2,
       description = $3,
       photo_url = $4,
       address = $5,
       website = $6,
       hours = $7,
       phone = $8,
       lng = $9,
       lat = $10,
       attributes = $11::jsonb,
       field_provenance = $12::jsonb,
       popularity = $13,
       status = $14,
       primary_category_id = $15,
       starts_at = $16,
       ends_at = $17,
       date_precision = $18,
       updated_at = now()
     WHERE id = $1`,
    [
      canonicalId,
      finalName,
      description.value,
      photo.value,
      address.value,
      website.value,
      hours.value,
      phone.value,
      finalCoords.lng,
      finalCoords.lat,
      JSON.stringify(attributes),
      JSON.stringify(fieldProvenance),
      popularity,
      primaryCategoryId ? "published" : "hidden",
      primaryCategoryId,
      dates?.starts_at ?? null,
      dates?.ends_at ?? null,
      dates?.date_precision ?? null,
    ],
  );
}
