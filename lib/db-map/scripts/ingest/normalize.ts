/**
 * Normalize + categorize research_pois (M5).
 *
 * Resumable loop over rows where name_normalized IS NULL (set on first insert and
 * whenever content_hash changes). Non-POI rows (attributes._is_poi = false) are
 * skipped so they never become matchable — the validity gate (overview §15.1).
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:normalize [--source <slug>] [--limit N] [--no-llm]
 *   pnpm --filter @lib/db-map ingest:normalize --report-unmapped [--source <slug>]
 *   pnpm --filter @lib/db-map ingest:normalize --report-coverage [--source <slug>]
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { normalizeName, websiteDomain, normalizePhone } from "./normalize/text.js";
import { fixCoordinates } from "./normalize/geo.js";
import { coordsFromRecordUrls } from "./normalize/urlcoords.js";
import { parseEventDates } from "./normalize/dates.js";
import { countryToCode } from "./normalize/country.js";
import {
  loadAliasMap,
  loadValidSlugs,
  resolveCategorySlugs,
  type AliasMap,
} from "./normalize/category.js";

interface CliOptions {
  source?: string;
  limit?: number;
  reportUnmapped: boolean;
  reportCoverage: boolean;
  noLlm: boolean;
}

interface NormalizeStats {
  processed: number;
  swappedCoords: number;
  droppedCoords: number;
  urlCoords: number;
  dated: number;
  llmDated: number;
  swappedDates: number;
  categorized: number;
  unmapped: number;
  skipped: number;
}

interface ResearchRow {
  id: string;
  name: string | null;
  website: string | null;
  source_url: string | null;
  phone: string | null;
  country_code: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
  raw_category: string | null;
  ingest_category: string | null;
  country_name: string | null;
  attributes: Record<string, unknown> | null;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let limit: number | undefined;
  let reportUnmapped = false;
  let reportCoverage = false;
  let noLlm = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report-unmapped") reportUnmapped = true;
    else if (a === "--report-coverage") reportCoverage = true;
    else if (a === "--no-llm") noLlm = true;
    else if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
  }

  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`Invalid --limit: ${limit}`);
  }
  return { source, limit, reportUnmapped, reportCoverage, noLlm };
}

async function resolveSourceId(db: Pool, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM research_sources WHERE slug = $1`,
    [slug],
  );
  if (rows.length === 0) throw new Error(`Unknown source slug: ${slug}`);
  return rows[0]!.id;
}

/** Validity gate (overview §15.1): only real POIs are normalized (and thus matchable). */
const POI_FILTER = `is_poi`;

async function runNormalize(
  db: Pool,
  opts: CliOptions,
  aliasMap: AliasMap,
  validSlugs: Set<string>,
): Promise<NormalizeStats> {
  const stats: NormalizeStats = {
    processed: 0,
    swappedCoords: 0,
    droppedCoords: 0,
    urlCoords: 0,
    dated: 0,
    llmDated: 0,
    swappedDates: 0,
    categorized: 0,
    unmapped: 0,
    skipped: 0,
  };

  const params: unknown[] = [];
  let where = `name_normalized IS NULL AND ${POI_FILTER}`;
  if (opts.source) {
    params.push(await resolveSourceId(db, opts.source));
    where += ` AND source_id = $${params.length}`;
  }
  let limitClause = "";
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    limitClause = ` LIMIT $${params.length}`;
  }

  const { rows } = await db.query<ResearchRow>(
    `SELECT id, name, website, source_url, phone, country_code, region, lat, lng,
            raw_category, ingest_category, attributes->>'country_name' AS country_name,
            attributes
     FROM research_pois
     WHERE ${where}
     ORDER BY first_seen_at${limitClause}`,
    params,
  );

  for (const row of rows) {
    const nameNormalized = row.name ? normalizeName(row.name) : null;
    // A row with no usable name cannot be matched; skip (stays NULL, filtered next run).
    if (!nameNormalized) {
      stats.skipped++;
      console.warn(`Skipped - ${row.name ?? `(id ${row.id})`} - no usable name`);
      continue;
    }

    const coords = fixCoordinates(row.lat, row.lng);
    if (coords.swapped) stats.swappedCoords++;
    if (coords.dropped) stats.droppedCoords++;

    // URL-embedded coordinates (Google Maps links etc.) — zero geocoder spend.
    if (coords.lat === null) {
      const fromUrl = coordsFromRecordUrls(row);
      if (fromUrl) {
        coords.lat = fromUrl.lat;
        coords.lng = fromUrl.lng;
        stats.urlCoords++;
      }
    }

    const domain = websiteDomain(row.website);
    const phone = normalizePhone(row.phone);

    const countryCode =
      row.country_code ??
      countryToCode(row.region) ??
      countryToCode(row.country_name ?? undefined) ??
      null;

    // Event dates: deterministic parse of attribute date strings, with LLM prose
    // fallback ("every February" → concrete upcoming dates).
    const attrs = row.attributes ?? {};
    const dates = await parseEventDates({
      start: attrs.start_date as string | undefined,
      end: attrs.end_date as string | undefined,
      text: (attrs.date_text ?? attrs.dates ?? attrs.date_raw) as string | undefined,
      allowLlm: !opts.noLlm,
    });
    if (dates.starts_at) stats.dated++;
    if (dates.date_source === "llm") stats.llmDated++;
    if (dates.swapped) stats.swappedDates++;

    const { slugs, unmapped } = resolveCategorySlugs(
      aliasMap,
      validSlugs,
      row.raw_category,
      row.ingest_category,
    );
    if (slugs.length > 0) stats.categorized++;
    if (unmapped) stats.unmapped++;

    await db.query(
      `UPDATE research_pois SET
         name_normalized = $2,
         website_domain = $3,
         phone = $4,
         country_code = $5,
         lat = $6,
         lng = $7,
         category_slugs = $8,
         starts_at = $9,
         ends_at = $10,
         date_precision = $11,
         attributes = attributes || $12::jsonb
       WHERE id = $1`,
      [
        row.id,
        nameNormalized,
        domain,
        phone,
        countryCode,
        coords.lat,
        coords.lng,
        slugs,
        dates.starts_at,
        dates.ends_at,
        dates.date_precision,
        JSON.stringify(dates.date_source ? { date_source: dates.date_source } : {}),
      ],
    );
    stats.processed++;
    const dateNote = dates.starts_at
      ? ` (${dates.starts_at}${dates.ends_at ? ` → ${dates.ends_at}` : ""}${dates.date_source === "llm" ? ", llm" : ""}${dates.swapped ? ", swap-repaired" : ""})`
      : "";
    console.log(`✓ ${row.name}${dateNote}`);
  }

  return stats;
}

async function reportUnmapped(db: Pool, opts: CliOptions): Promise<void> {
  const params: unknown[] = [];
  let where = `raw_category IS NOT NULL AND ${POI_FILTER}`;
  if (opts.source) {
    params.push(await resolveSourceId(db, opts.source));
    where += ` AND source_id = $${params.length}`;
  }

  const { rows } = await db.query<{ raw_category: string; n: number }>(
    `SELECT rp.raw_category, count(*)::int n
     FROM research_pois rp
     WHERE ${where}
       AND lower(rp.raw_category) NOT IN (
         SELECT alias FROM research_category_aliases WHERE source_id IS NULL
       )
     GROUP BY rp.raw_category
     ORDER BY n DESC`,
    params,
  );

  if (rows.length === 0) {
    console.log("No unmapped raw categories. Every raw_category resolves to an alias.");
    return;
  }
  console.log("Unmapped raw categories (add aliases to taxonomy.ts, then re-seed):");
  for (const r of rows) {
    console.log(`  ${r.n.toString().padStart(6)}  ${r.raw_category}`);
  }
}

async function reportCoverage(db: Pool, opts: CliOptions): Promise<void> {
  const params: unknown[] = [];
  let where = "1=1";
  if (opts.source) {
    params.push(await resolveSourceId(db, opts.source));
    where += ` AND source_id = $${params.length}`;
  }

  const { rows } = await db.query<Record<string, number>>(
    `SELECT
       count(*)::int AS total,
       count(name)::int AS name,
       count(website)::int AS website,
       count(source_url)::int AS source_url,
       count(phone)::int AS phone,
       count(email)::int AS email,
       count(address)::int AS address,
       count(city)::int AS city,
       count(region)::int AS region,
       count(country_code)::int AS country_code,
       count(lat)::int AS coordinates,
       count(name_normalized)::int AS name_normalized
     FROM research_pois
     WHERE ${where}`,
    params,
  );

  const r = rows[0]!;
  const total = r.total;
  if (!total) {
    console.log("No research_pois rows to report.");
    return;
  }
  console.log(`Field coverage (${total} rows${opts.source ? `, source=${opts.source}` : ""}):`);
  const fields = [
    "name",
    "website",
    "source_url",
    "phone",
    "email",
    "address",
    "city",
    "region",
    "country_code",
    "coordinates",
    "name_normalized",
  ];
  for (const f of fields) {
    const n = r[f] ?? 0;
    const pct = ((n / total) * 100).toFixed(0);
    console.log(`  ${f.padEnd(16)} ${pct.padStart(3)}%  (${n}/${total})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();

  if (opts.reportUnmapped) {
    await reportUnmapped(db, opts);
    await db.end();
    return;
  }
  if (opts.reportCoverage) {
    await reportCoverage(db, opts);
    await db.end();
    return;
  }

  const aliasMap = await loadAliasMap(db);
  const validSlugs = await loadValidSlugs(db);
  const stats = await runNormalize(db, opts, aliasMap, validSlugs);
  await db.end();

  console.log(
    `Normalize${opts.source ? ` ${opts.source}` : ""}: processed=${stats.processed} ` +
      `skipped=${stats.skipped} categorized=${stats.categorized} unmapped=${stats.unmapped} ` +
      `swapped_coords=${stats.swappedCoords} dropped_coords=${stats.droppedCoords} ` +
      `url_coords=${stats.urlCoords} dated=${stats.dated} llm_dated=${stats.llmDated} ` +
      `swapped_dates=${stats.swappedDates}`,
  );
}

main().catch((err) => {
  console.error("Normalize failed:", err);
  process.exit(1);
});
