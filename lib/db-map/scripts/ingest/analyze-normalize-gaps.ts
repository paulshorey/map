/**
 * Read-only audit: how well current normalize prepares research_pois for geocode/match.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:analyze-gaps [--source <slug>] [--category <slug>]
 */
import { getDb } from "../../lib/db/postgres.js";

interface CliOptions {
  source?: string;
  category?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let category: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--category" && argv[i + 1]) category = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { source, category };
}

const FILTER = `
  ($1::text IS NULL OR rs.slug = $1)
  AND ($2::text IS NULL OR rp.ingest_category = $2 OR $2 = ANY(rp.category_slugs))
`;

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(0)}%`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const params = [opts.source ?? null, opts.category ?? null];

  const { rows: summary } = await db.query<{
    total: string;
    poi: string;
    normalized: string;
    has_coords: string;
    has_country: string;
    has_city: string;
    has_region: string;
    has_address: string;
    has_venue: string;
    has_dates: string;
    edition_in_name: string;
    edition_in_normalized: string;
    bad_country_name: string;
    street_in_city: string;
    missing_geocode_inputs: string;
  }>(
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE rp.is_poi)::text AS poi,
       count(rp.name_normalized) FILTER (WHERE rp.is_poi)::text AS normalized,
       count(rp.lat) FILTER (WHERE rp.is_poi)::text AS has_coords,
       count(rp.country_code) FILTER (WHERE rp.is_poi)::text AS has_country,
       count(rp.city) FILTER (WHERE rp.is_poi)::text AS has_city,
       count(rp.region) FILTER (WHERE rp.is_poi)::text AS has_region,
       count(rp.address) FILTER (WHERE rp.is_poi)::text AS has_address,
       count(rp.attributes->>'venue') FILTER (WHERE rp.is_poi)::text AS has_venue,
       count(rp.starts_at) FILTER (WHERE rp.is_poi)::text AS has_dates,
       count(*) FILTER (
         WHERE rp.is_poi AND rp.name ~* '\\m20[0-9]{2}\\M'
       )::text AS edition_in_name,
       count(*) FILTER (
         WHERE rp.is_poi AND rp.name_normalized ~* '\\m20[0-9]{2}\\M'
       )::text AS edition_in_normalized,
       count(*) FILTER (
         WHERE rp.is_poi
           AND rp.country_code IS NULL
           AND rp.attributes->>'country_name' IS NOT NULL
       )::text AS bad_country_name,
       count(*) FILTER (
         WHERE rp.is_poi
           AND rp.city ~* '\\d'
           AND rp.city ~* '(st|street|ave|road|rd|blvd|way|weg|straße|strasse)'
       )::text AS street_in_city,
       count(*) FILTER (
         WHERE rp.is_poi
           AND rp.lat IS NULL
           AND rp.name_normalized IS NOT NULL
           AND rp.city IS NULL
           AND rp.region IS NULL
           AND rp.country_code IS NULL
           AND rp.address IS NULL
           AND rp.attributes->>'venue' IS NULL
           AND rp.attributes->>'country_name' IS NULL
       )::text AS missing_geocode_inputs
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE ${FILTER}`,
    params,
  );

  const s = summary[0]!;
  const total = Number(s.poi);
  console.log(`\n# Normalize gap analysis${opts.source ? ` (source=${opts.source})` : ""}${opts.category ? ` category=${opts.category}` : ""}`);
  console.log(`POI rows: ${total} (of ${s.total} total)`);
  if (total === 0) {
    await db.end();
    return;
  }

  const metrics: [string, number][] = [
    ["normalized", Number(s.normalized)],
    ["has_coords", Number(s.has_coords)],
    ["has_country_code", Number(s.has_country)],
    ["has_city", Number(s.has_city)],
    ["has_region", Number(s.has_region)],
    ["has_address", Number(s.has_address)],
    ["has_venue (attr)", Number(s.has_venue)],
    ["has_starts_at", Number(s.has_dates)],
  ];
  console.log("\n## Field coverage (POI rows)");
  for (const [label, n] of metrics) {
    console.log(`  ${label.padEnd(22)} ${pct(n, total).padStart(4)}  (${n}/${total})`);
  }

  console.log("\n## Quality signals (higher = more LLM-normalize would help)");
  const issues: [string, number][] = [
    ["edition year in display name", Number(s.edition_in_name)],
    ["edition year in name_normalized", Number(s.edition_in_normalized)],
    ["country_name present but no country_code", Number(s.bad_country_name)],
    ["street-like text in city column", Number(s.street_in_city)],
    ["no geocode inputs after normalize", Number(s.missing_geocode_inputs)],
  ];
  for (const [label, n] of issues) {
    console.log(`  ${label.padEnd(40)} ${String(n).padStart(5)}  (${pct(n, total)})`);
  }

  const { rows: samples } = await db.query<{
    name: string;
    city: string | null;
    country_code: string | null;
    country_name: string | null;
    name_normalized: string | null;
  }>(
    `SELECT rp.name, rp.city, rp.country_code,
            rp.attributes->>'country_name' AS country_name,
            rp.name_normalized
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE ${FILTER}
       AND rp.is_poi
       AND (
         rp.country_code IS NULL AND rp.attributes->>'country_name' IS NOT NULL
         OR rp.name_normalized ~* '\\m20[0-9]{2}\\M'
         OR (rp.city ~* '\\d' AND rp.city ~* '(st|street|ave|road|rd|blvd|way)')
       )
     ORDER BY rp.name
     LIMIT 15`,
    params,
  );

  if (samples.length > 0) {
    console.log("\n## Sample rows needing enrichment");
    for (const r of samples) {
      console.log(
        `  - ${r.name}\n` +
          `    normalized=${r.name_normalized ?? "null"} city=${r.city ?? "null"} ` +
          `country=${r.country_code ?? "null"} country_name=${r.country_name ?? "null"}`,
      );
    }
  }

  await db.end();
}

main().catch((err) => {
  console.error("analyze-normalize-gaps failed:", err);
  process.exit(1);
});
