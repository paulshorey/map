/**
 * Read-only ingestion reconciliation report.
 *
 * Prints a compact summary of pipeline state: research rows by source and stage,
 * match readiness, canonical counts, match decisions by method, geocode cache
 * effectiveness, popularity distribution, and event date coverage. Never mutates data.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:report
 *   pnpm --filter @lib/db-map ingest:report --source <source-slug>
 *   pnpm --filter @lib/db-map ingest:report --category <category-slug>
 */
import type { Pool } from "pg";
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
    else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  return { source, category };
}

function fmt(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString("en-US") : "0";
}

function pct(part: number | string | null | undefined, total: number | string | null | undefined): string {
  const p = Number(part ?? 0);
  const t = Number(total ?? 0);
  if (t === 0) return "0%";
  return `${((p / t) * 100).toFixed(0)}%`;
}

function heading(title: string): void {
  console.log(`\n## ${title}`);
}

/** Shared research-side filter: $1 = source slug or NULL, $2 = category slug or NULL. */
const RESEARCH_FILTER = `
  ($1::text IS NULL OR rs.slug = $1)
  AND ($2::text IS NULL OR rp.ingest_category = $2 OR $2 = ANY(rp.category_slugs))
`;

async function reportResearchBySource(db: Pool, opts: CliOptions): Promise<void> {
  const { rows } = await db.query<{
    slug: string;
    category: string | null;
    total: string;
    non_poi: string;
    normalized: string;
    with_coords: string;
    embedded: string;
    linked: string;
    pending: string;
  }>(
    `SELECT
       rs.slug,
       rp.ingest_category AS category,
       count(*)::text AS total,
       count(*) FILTER (WHERE NOT rp.is_poi)::text AS non_poi,
       count(rp.name_normalized) FILTER (WHERE rp.is_poi)::text AS normalized,
       count(rp.lat) FILTER (WHERE rp.is_poi)::text AS with_coords,
       count(rp.content_embedding) FILTER (WHERE rp.is_poi)::text AS embedded,
       count(rp.canonical_poi_id)::text AS linked,
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL
           AND rp.is_poi
           AND rp.lat IS NOT NULL AND rp.lng IS NOT NULL
           AND rp.name_normalized IS NOT NULL
           AND rp.category_slugs IS NOT NULL
       )::text AS pending
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE ${RESEARCH_FILTER}
     GROUP BY rs.slug, rp.ingest_category
     ORDER BY count(*) DESC`,
    [opts.source ?? null, opts.category ?? null],
  );

  heading("Research rows by source");
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  console.log(
    "source            category          total    non_poi  normalized  coords   embedded  linked   pending",
  );
  for (const r of rows) {
    console.log(
      [
        r.slug.padEnd(18),
        (r.category ?? "-").padEnd(16),
        fmt(r.total).padStart(7),
        fmt(r.non_poi).padStart(8),
        fmt(r.normalized).padStart(11),
        fmt(r.with_coords).padStart(8),
        fmt(r.embedded).padStart(9),
        fmt(r.linked).padStart(8),
        fmt(r.pending).padStart(8),
      ].join(" "),
    );
  }
}

async function reportNotReady(db: Pool, opts: CliOptions): Promise<void> {
  const { rows } = await db.query<{
    missing_coords: string;
    missing_name: string;
    missing_categories: string;
    pending: string;
    linked: string;
  }>(
    `SELECT
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL AND rp.is_poi AND (rp.lat IS NULL OR rp.lng IS NULL)
       )::text AS missing_coords,
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL AND rp.is_poi
           AND rp.lat IS NOT NULL AND rp.lng IS NOT NULL
           AND rp.name_normalized IS NULL
       )::text AS missing_name,
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL AND rp.is_poi
           AND rp.lat IS NOT NULL AND rp.lng IS NOT NULL
           AND rp.name_normalized IS NOT NULL
           AND rp.category_slugs IS NULL
       )::text AS missing_categories,
       count(*) FILTER (
         WHERE rp.canonical_poi_id IS NULL AND rp.is_poi
           AND rp.lat IS NOT NULL AND rp.lng IS NOT NULL
           AND rp.name_normalized IS NOT NULL AND rp.category_slugs IS NOT NULL
       )::text AS pending,
       count(rp.canonical_poi_id)::text AS linked
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE ${RESEARCH_FILTER}`,
    [opts.source ?? null, opts.category ?? null],
  );
  const r = rows[0]!;
  heading("Match readiness");
  console.log(`linked:             ${fmt(r.linked)}`);
  console.log(`pending (ready):    ${fmt(r.pending)}`);
  console.log(`missing coords:     ${fmt(r.missing_coords)}`);
  console.log(`missing name:       ${fmt(r.missing_name)}`);
  console.log(`missing categories: ${fmt(r.missing_categories)}`);
}

async function reportCanonicals(db: Pool, opts: CliOptions): Promise<void> {
  const { rows } = await db.query<{
    slug: string | null;
    total: string;
    published: string;
    hidden: string;
  }>(
    `SELECT
       cc.slug,
       count(DISTINCT cp.id)::text AS total,
       count(DISTINCT cp.id) FILTER (WHERE cp.status = 'published')::text AS published,
       count(DISTINCT cp.id) FILTER (WHERE cp.status = 'hidden')::text AS hidden
     FROM canonical_pois cp
     LEFT JOIN canonical_poi_categories cpc ON cpc.poi_id = cp.id AND cpc.is_primary
     LEFT JOIN canonical_categories cc ON cc.id = cpc.category_id
     WHERE ($1::text IS NULL OR cc.slug = $1)
     GROUP BY cc.slug
     ORDER BY count(DISTINCT cp.id) DESC`,
    [opts.category ?? null],
  );

  heading("Canonical POIs by primary category");
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  console.log("category            total    published  hidden");
  for (const r of rows) {
    console.log(
      [
        (r.slug ?? "(uncategorized)").padEnd(18),
        fmt(r.total).padStart(7),
        fmt(r.published).padStart(10),
        fmt(r.hidden).padStart(7),
      ].join(" "),
    );
  }
}

async function reportDecisions(db: Pool, opts: CliOptions): Promise<void> {
  const { rows } = await db.query<{ method: string; decision: string; count: string }>(
    `SELECT rmd.method, rmd.decision, count(*)::text AS count
     FROM research_match_decisions rmd
     JOIN research_pois rp ON rp.id = rmd.research_id
     JOIN research_sources rs ON rs.id = rp.source_id
     WHERE ${RESEARCH_FILTER}
     GROUP BY rmd.method, rmd.decision
     ORDER BY count(*) DESC`,
    [opts.source ?? null, opts.category ?? null],
  );
  heading("Match decisions by method");
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  for (const r of rows) {
    console.log(`${`${r.method}/${r.decision}`.padEnd(22)} ${fmt(r.count).padStart(8)}`);
  }
  const llmTotal = rows
    .filter((r) => r.method === "llm")
    .reduce((sum, r) => sum + Number(r.count), 0);
  console.log(`llm decisions total:   ${fmt(llmTotal).padStart(8)}`);
}

async function reportGeocodeCache(db: Pool): Promise<void> {
  const { rows } = await db.query<{ total: string; hits: string; misses: string }>(
    `SELECT
       count(*)::text AS total,
       count(*) FILTER (WHERE lat IS NOT NULL)::text AS hits,
       count(*) FILTER (WHERE lat IS NULL)::text AS misses
     FROM research_geocode_cache`,
  );
  const r = rows[0]!;
  heading("Geocode cache (global)");
  console.log(`entries: ${fmt(r.total)}  resolved: ${fmt(r.hits)}  remembered misses: ${fmt(r.misses)}`);
}

async function reportPopularity(db: Pool, opts: CliOptions): Promise<void> {
  const { rows } = await db.query<{ popularity: number; count: string }>(
    `SELECT cp.popularity, count(*)::text AS count
     FROM canonical_pois cp
     WHERE cp.status = 'published'
       AND ($1::text IS NULL OR EXISTS (
         SELECT 1 FROM canonical_poi_categories cpc
         JOIN canonical_categories cc ON cc.id = cpc.category_id
         WHERE cpc.poi_id = cp.id AND cc.slug = $1
       ))
     GROUP BY cp.popularity
     ORDER BY cp.popularity`,
    [opts.category ?? null],
  );
  heading("Published popularity distribution (distinct sources per canonical)");
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  for (const r of rows) {
    console.log(`${String(r.popularity).padStart(3)} source(s): ${fmt(r.count).padStart(8)}`);
  }
}

async function reportTopSources(db: Pool, opts: CliOptions): Promise<void> {
  const { rows } = await db.query<{ slug: string; canonicals: string }>(
    `SELECT rs.slug, count(DISTINCT rp.canonical_poi_id)::text AS canonicals
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     JOIN canonical_pois cp ON cp.id = rp.canonical_poi_id AND cp.status = 'published'
     WHERE ${RESEARCH_FILTER}
     GROUP BY rs.slug
     ORDER BY count(DISTINCT rp.canonical_poi_id) DESC
     LIMIT 15`,
    [opts.source ?? null, opts.category ?? null],
  );
  heading("Top sources contributing to published canonicals");
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  for (const r of rows) {
    console.log(`${r.slug.padEnd(22)} ${fmt(r.canonicals).padStart(8)}`);
  }
}

async function reportEventDates(db: Pool, opts: CliOptions): Promise<void> {
  const { rows } = await db.query<{
    slug: string;
    total: string;
    dated: string;
    occurrences: string;
  }>(
    `SELECT
       cc.slug,
       count(DISTINCT cp.id)::text AS total,
       count(DISTINCT cp.id) FILTER (WHERE cp.starts_at IS NOT NULL)::text AS dated,
       count(cpo.id)::text AS occurrences
     FROM canonical_pois cp
     JOIN canonical_poi_categories cpc ON cpc.poi_id = cp.id
     JOIN canonical_categories cc ON cc.id = cpc.category_id AND cc.is_temporal
     LEFT JOIN canonical_poi_occurrences cpo ON cpo.poi_id = cp.id
     WHERE cp.status = 'published'
       AND ($1::text IS NULL OR cc.slug = $1)
     GROUP BY cc.slug
     ORDER BY count(DISTINCT cp.id) DESC`,
    [opts.category ?? null],
  );
  heading("Event date coverage (published temporal categories)");
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  console.log("category            total   with dates  occurrences");
  for (const r of rows) {
    console.log(
      [
        r.slug.padEnd(18),
        fmt(r.total).padStart(6),
        `${fmt(r.dated)} (${pct(r.dated, r.total)})`.padStart(12),
        fmt(r.occurrences).padStart(12),
      ].join(" "),
    );
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();

  if (opts.source) {
    const { rows } = await db.query(`SELECT 1 FROM research_sources WHERE slug = $1`, [opts.source]);
    if (rows.length === 0) throw new Error(`Unknown source slug: ${opts.source}`);
  }
  if (opts.category) {
    const { rows } = await db.query(`SELECT 1 FROM canonical_categories WHERE slug = $1`, [opts.category]);
    if (rows.length === 0) throw new Error(`Unknown category slug: ${opts.category}`);
  }

  console.log(
    `# Ingestion report${opts.source ? ` — source=${opts.source}` : ""}${opts.category ? ` — category=${opts.category}` : ""} (${new Date().toISOString()})`,
  );

  await reportResearchBySource(db, opts);
  await reportNotReady(db, opts);
  await reportCanonicals(db, opts);
  await reportDecisions(db, opts);
  await reportGeocodeCache(db);
  await reportPopularity(db, opts);
  await reportTopSources(db, opts);
  await reportEventDates(db, opts);

  await db.end();
}

main().catch((err) => {
  console.error("Report failed:", err);
  process.exit(1);
});
