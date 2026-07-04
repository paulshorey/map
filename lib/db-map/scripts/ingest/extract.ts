/**
 * Extract raw source data into research_pois (M4.2).
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:extract <source-slug> <file> [--limit N] [--dry-run]
 */
import { resolve } from "node:path";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { contentHash } from "./hash.js";
import {
  getExtractor,
  getSourceDefinition,
  listSourceSlugs,
} from "./sources.js";
import type { RawRecord } from "./types.js";
import { withPoiFlag } from "./extractors/utils.js";

interface CliOptions {
  sourceSlug: string;
  file: string;
  limit?: number;
  dryRun: boolean;
  ingestCategory?: string;
}

interface ExtractStats {
  seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const sourceSlug = positional[0];
  const file = positional[1];
  if (!sourceSlug || !file) {
    console.error(
      "Usage: ingest:extract <source-slug> <file> [--limit N] [--dry-run] [--ingest-category slug]",
    );
    process.exit(1);
  }

  let limit: number | undefined;
  let dryRun = false;
  let ingestCategory: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    if (a === "--ingest-category" && argv[i + 1]) ingestCategory = argv[++i];
  }

  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`Invalid --limit: ${limit}`);
  }

  return { sourceSlug, file: resolve(file), limit, dryRun, ingestCategory };
}

async function ensureSourceId(db: Pool, slug: string): Promise<string> {
  const def = getSourceDefinition(slug);
  if (!def) {
    throw new Error(`Unknown source "${slug}". Known: ${listSourceSlugs().join(", ")}`);
  }
  const m = def.meta;
  const { rows } = await db.query(
    `INSERT INTO research_sources (slug, name, homepage, license, attribution, trust)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       homepage = COALESCE(EXCLUDED.homepage, research_sources.homepage),
       license = COALESCE(EXCLUDED.license, research_sources.license),
       attribution = COALESCE(EXCLUDED.attribution, research_sources.attribution),
       trust = EXCLUDED.trust
     RETURNING id`,
    [m.slug, m.name, m.homepage ?? null, m.license ?? null, m.attribution ?? null, m.trust],
  );
  return rows[0].id as string;
}

const INSERT_SQL = `
INSERT INTO research_pois (
  source_id, source_record_id, ingest_category,
  name, description, website, source_url, phone, email,
  address, city, region, country_code, lng, lat,
  raw_category, raw, attributes, content_hash
) VALUES (
  $1, $2, $3,
  $4, $5, $6, $7, $8, $9,
  $10, $11, $12, $13, $14, $15,
  $16, $17::jsonb, $18::jsonb, $19
)`;

const UPDATE_CHANGED_SQL = `
UPDATE research_pois SET
  last_seen_at = now(),
  ingest_category = $3,
  name = $4, description = $5, website = $6, source_url = $7,
  phone = $8, email = $9, address = $10, city = $11, region = $12,
  country_code = $13, lng = $14, lat = $15, raw_category = $16,
  raw = $17::jsonb, attributes = $18::jsonb, content_hash = $19,
  name_normalized = NULL, content_embedding = NULL, canonical_poi_id = NULL
WHERE id = $20`;

async function upsertRecord(
  db: Pool,
  sourceId: string,
  ingestCategory: string | null,
  record: RawRecord,
): Promise<"inserted" | "updated" | "unchanged"> {
  const hash = contentHash(record);
  const params = [
    sourceId,
    record.source_record_id,
    ingestCategory,
    record.name ?? null,
    record.description ?? null,
    record.website ?? null,
    record.source_url ?? null,
    record.phone ?? null,
    record.email ?? null,
    record.address ?? null,
    record.city ?? null,
    record.region ?? null,
    record.country_code ?? null,
    record.lng ?? null,
    record.lat ?? null,
    record.raw_category ?? null,
    JSON.stringify(record.raw),
    JSON.stringify(record.attributes ?? {}),
    hash,
  ];

  const existing = await db.query<{ id: string; content_hash: string | null }>(
    `SELECT id, content_hash FROM research_pois
     WHERE source_id = $1 AND source_record_id = $2`,
    [sourceId, record.source_record_id],
  );

  if (existing.rows.length === 0) {
    await db.query(INSERT_SQL, params);
    return "inserted";
  }

  const row = existing.rows[0]!;
  if (row.content_hash === hash) {
    await db.query(`UPDATE research_pois SET last_seen_at = now() WHERE id = $1`, [row.id]);
    return "unchanged";
  }

  await db.query(UPDATE_CHANGED_SQL, [...params, row.id]);
  return "updated";
}

function previewRecord(record: RawRecord, hash: string): void {
  console.log(
    JSON.stringify(
      {
        source_record_id: record.source_record_id,
        name: record.name,
        city: record.city,
        lat: record.lat,
        lng: record.lng,
        website: record.website,
        source_url: record.source_url,
        raw_category: record.raw_category,
        content_hash: hash.slice(0, 12) + "…",
      },
      null,
      2,
    ),
  );
}

async function runExtract(opts: CliOptions): Promise<ExtractStats> {
  const def = getSourceDefinition(opts.sourceSlug);
  if (!def) {
    throw new Error(`Unknown source "${opts.sourceSlug}"`);
  }
  const extractor = getExtractor(opts.sourceSlug);
  if (!extractor) {
    throw new Error(
      `No extractor implemented for "${opts.sourceSlug}" yet (metadata is registered).`,
    );
  }

  const ingestCategory =
    opts.ingestCategory ?? def.meta.defaultIngestCategory ?? null;
  const stats: ExtractStats = {
    seen: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };

  const db = opts.dryRun ? null : getDb();
  const sourceId = db ? await ensureSourceId(db, opts.sourceSlug) : null;

  for await (const record of extractor.parse(opts.file)) {
    if (opts.limit !== undefined && stats.seen >= opts.limit) break;

    const isPoi = extractor.isPoi ? extractor.isPoi(record.raw) : true;
    const finalRecord = withPoiFlag(record, isPoi);
    const hash = contentHash(finalRecord);

    if (!finalRecord.source_record_id) {
      stats.skipped++;
      continue;
    }

    stats.seen++;

    if (opts.dryRun) {
      previewRecord(finalRecord, hash);
      continue;
    }

    const result = await upsertRecord(db!, sourceId!, ingestCategory, finalRecord);
    stats[result]++;
  }

  if (db) {
    await db.query(
      `UPDATE research_sources SET last_ingested_at = now() WHERE id = $1`,
      [sourceId],
    );
    await db.end();
  }

  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const stats = await runExtract(opts);

  const mode = opts.dryRun ? " (dry-run)" : "";
  console.log(
    `Extract${mode} ${opts.sourceSlug}: seen=${stats.seen} inserted=${stats.inserted} updated=${stats.updated} unchanged=${stats.unchanged} skipped=${stats.skipped}`,
  );
}

main().catch((err) => {
  console.error("Extract failed:", err);
  process.exit(1);
});
