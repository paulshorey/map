/**
 * Extract raw source data into research_pois (M4.2).
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:extract <source-slug> <file> --category <slug> [--limit N] [--dry-run]
 *
 * --category is required (product decision): the developer must state which taxonomy
 * category a file belongs to on every run. There is no per-source default to fall back
 * on, and an unknown slug is a hard error — extend taxonomy.ts + re-seed first.
 */
import { resolve } from "node:path";
import type { Pool } from "pg";
import { closeDb, getDb } from "../../lib/db/postgres.js";
import { contentHash } from "./hash.js";
import { TAXONOMY } from "./taxonomy.js";
import {
  getExtractor,
  getSourceDefinition,
  listSourceSlugs,
} from "./sources.js";
import type { RawRecord } from "./types.js";

const VALID_CATEGORY_SLUGS = new Set(TAXONOMY.map((c) => c.slug));

interface CliOptions {
  sourceSlug: string;
  file: string;
  limit?: number;
  dryRun: boolean;
  category: string;
}

interface ExtractStats {
  seen: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

function isTransientDbError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const code = typeof err === "object" && err ? (err as { code?: unknown }).code : undefined;
  return (
    message.includes("Connection terminated") ||
    message.includes("Connection ended unexpectedly") ||
    message.includes("ECONNRESET") ||
    code === "ECONNRESET" ||
    code === "57P01" ||
    code === "57P02" ||
    code === "08006"
  );
}

function usageError(message: string): never {
  console.error(message);
  console.error(
    "Usage: ingest:extract <source-slug> <file> --category <slug> [--limit N] [--dry-run]",
  );
  console.error(`Known categories: ${[...VALID_CATEGORY_SLUGS].sort().join(", ")}`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const sourceSlug = positional[0];
  const file = positional[1];
  if (!sourceSlug || !file) {
    usageError("Missing <source-slug> and/or <file>.");
  }

  let limit: number | undefined;
  let dryRun = false;
  let category: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    if (a === "--category" && argv[i + 1]) category = argv[++i];
  }

  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`Invalid --limit: ${limit}`);
  }

  if (!category) {
    usageError("Missing required --category <slug>.");
  }
  if (!VALID_CATEGORY_SLUGS.has(category)) {
    usageError(`Unknown category "${category}" — not in taxonomy.ts.`);
  }

  return { sourceSlug, file: resolve(file), limit, dryRun, category };
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
  raw_category, is_poi, raw, attributes, content_hash
) VALUES (
  $1, $2, $3,
  $4, $5, $6, $7, $8, $9,
  $10, $11, $12, $13, $14, $15,
  $16, $17, $18::jsonb, $19::jsonb, $20
)`;

// A changed hash resets derived columns so the record re-flows the stages.
const UPDATE_CHANGED_SQL = `
UPDATE research_pois SET
  last_seen_at = now(),
  ingest_category = $1,
  name = $2, description = $3, website = $4, source_url = $5,
  phone = $6, email = $7, address = $8, city = $9, region = $10,
  country_code = $11, lng = $12, lat = $13, raw_category = $14,
  is_poi = $15, raw = $16::jsonb, attributes = $17::jsonb, content_hash = $18,
  name_normalized = NULL, category_slugs = NULL, content_embedding = NULL,
  coordinate_source = NULL, coordinate_precision = NULL, geocode_query_norm = NULL,
  canonical_poi_id = NULL
WHERE id = $19::uuid`;

async function upsertRecord(
  db: Pool,
  sourceId: string,
  ingestCategory: string | null,
  record: RawRecord,
  isPoi: boolean,
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
    isPoi,
    JSON.stringify(record.raw),
    JSON.stringify(record.attributes ?? {}),
    hash,
  ];

  const existing = await db.query<{
    id: string;
    content_hash: string | null;
    ingest_category: string | null;
  }>(
    `SELECT id, content_hash, ingest_category FROM research_pois
     WHERE source_id = $1 AND source_record_id = $2`,
    [sourceId, record.source_record_id],
  );

  if (existing.rows.length === 0) {
    await db.query(INSERT_SQL, params);
    return "inserted";
  }

  const row = existing.rows[0]!;
  if (row.content_hash === hash && row.ingest_category === ingestCategory) {
    await db.query(`UPDATE research_pois SET last_seen_at = now() WHERE id = $1::uuid`, [row.id]);
    return "unchanged";
  }

  await db.query(UPDATE_CHANGED_SQL, [...params.slice(2), row.id]);
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

  const ingestCategory = opts.category;
  const stats: ExtractStats = {
    seen: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };

  let db = opts.dryRun ? null : getDb();
  let sourceId = db ? await ensureSourceId(db, opts.sourceSlug) : null;

  for await (const record of extractor.parse(opts.file)) {
    if (opts.limit !== undefined && stats.seen >= opts.limit) break;

    const isPoi = extractor.isPoi ? extractor.isPoi(record.raw) : true;

    if (!record.source_record_id) {
      stats.skipped++;
      console.warn(`Skipped - ${record.name ?? "(unnamed)"} - no stable record id`);
      continue;
    }

    stats.seen++;

    if (opts.dryRun) {
      previewRecord(record, contentHash(record));
      continue;
    }

    let result: "inserted" | "updated" | "unchanged" | undefined;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        result = await upsertRecord(db!, sourceId!, ingestCategory, record, isPoi);
        break;
      } catch (err) {
        if (!isTransientDbError(err) || attempt === 3) throw err;
        console.warn(
          `Transient database error during extract; reconnecting and retrying ` +
            `${record.name ?? record.source_record_id} (attempt ${attempt + 1}/3)`,
        );
        await closeDb();
        db = getDb();
        sourceId = await ensureSourceId(db, opts.sourceSlug);
      }
    }
    if (!result) throw new Error("Extract retry loop exited without a result");
    stats[result]++;
    console.log(`✓ ${record.name ?? record.source_record_id} (${result}${isPoi ? "" : ", not a POI"})`);
  }

  if (db) {
    await db.query(
      `UPDATE research_sources SET last_ingested_at = now() WHERE id = $1`,
      [sourceId],
    );
    await closeDb();
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
