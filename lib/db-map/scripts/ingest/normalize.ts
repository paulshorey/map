/**
 * Normalize + categorize research_pois (M5).
 *
 * Resumable loop over rows where name_normalized IS NULL (set on first insert and
 * whenever content_hash changes). Non-POI rows (attributes._is_poi = false) are
 * skipped so they never become matchable — the validity gate (overview §15.1).
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:normalize [--source <slug>] [--limit N]
 *   pnpm --filter @lib/db-map ingest:normalize --report-unmapped [--source <slug>]
 *   pnpm --filter @lib/db-map ingest:normalize --report-coverage [--source <slug>]
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { normalizeName, websiteDomain, normalizePhone } from "./normalize/text.js";
import { fixCoordinates } from "./normalize/geo.js";
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
}

interface NormalizeStats {
  processed: number;
  swappedCoords: number;
  droppedCoords: number;
  categorized: number;
  unmapped: number;
}

interface ResearchRow {
  id: string;
  name: string | null;
  website: string | null;
  phone: string | null;
  country_code: string | null;
  region: string | null;
  lat: number | null;
  lng: number | null;
  raw_category: string | null;
  ingest_category: string | null;
  attributes: Record<string, unknown> | null;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let limit: number | undefined;
  let reportUnmapped = false;
  let reportCoverage = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report-unmapped") reportUnmapped = true;
    else if (a === "--report-coverage") reportCoverage = true;
    else if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
  }

  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`Invalid --limit: ${limit}`);
  }
  return { source, limit, reportUnmapped, reportCoverage };
}

async function resolveSourceId(db: Pool, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM research_sources WHERE slug = $1`,
    [slug],
  );
  if (rows.length === 0) throw new Error(`Unknown source slug: ${slug}`);
  return rows[0]!.id;
}

/** attributes._is_poi === false → validity gate rejects the row. */
const NON_POI_FILTER = `(attributes->>'_is_poi' IS DISTINCT FROM 'false')`;

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
    categorized: 0,
    unmapped: 0,
  };

  const params: unknown[] = [];
  let where = `name_normalized IS NULL AND ${NON_POI_FILTER}`;
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
    `SELECT id, name, website, phone, country_code, region, lat, lng,
            raw_category, ingest_category, attributes
     FROM research_pois
     WHERE ${where}
     ORDER BY first_seen_at${limitClause}`,
    params,
  );

  for (const row of rows) {
    const nameNormalized = row.name ? normalizeName(row.name) : null;
    // A row with no usable name cannot be matched; skip (stays NULL, filtered next run).
    if (!nameNormalized) continue;

    const coords = fixCoordinates(row.lat, row.lng);
    if (coords.swapped) stats.swappedCoords++;
    if (coords.dropped) stats.droppedCoords++;

    const domain = websiteDomain(row.website);
    const phone = normalizePhone(row.phone);

    const countryCode =
      row.country_code ??
      countryToCode(row.region) ??
      countryToCode(
        (row.attributes?.country_name as string | undefined) ?? undefined,
      ) ??
      null;

    const { slugs, unmapped } = resolveCategorySlugs(
      aliasMap,
      validSlugs,
      row.raw_category,
      row.ingest_category,
    );
    if (slugs.length > 0) stats.categorized++;
    if (unmapped) stats.unmapped++;

    const attributes = {
      ...(row.attributes ?? {}),
      _category_slugs: slugs,
      ...(unmapped ? { _unmapped_category: unmapped } : {}),
    };

    await db.query(
      `UPDATE research_pois SET
         name_normalized = $2,
         website_domain = $3,
         phone = $4,
         country_code = $5,
         lat = $6,
         lng = $7,
         attributes = $8::jsonb
       WHERE id = $1`,
      [
        row.id,
        nameNormalized,
        domain,
        phone,
        countryCode,
        coords.lat,
        coords.lng,
        JSON.stringify(attributes),
      ],
    );
    stats.processed++;
  }

  return stats;
}

async function reportUnmapped(db: Pool, opts: CliOptions): Promise<void> {
  const params: unknown[] = [];
  let where = `raw_category IS NOT NULL AND ${NON_POI_FILTER}`;
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
      `categorized=${stats.categorized} unmapped=${stats.unmapped} ` +
      `swapped_coords=${stats.swappedCoords} dropped_coords=${stats.droppedCoords}`,
  );
}

main().catch((err) => {
  console.error("Normalize failed:", err);
  process.exit(1);
});
