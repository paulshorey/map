/**
 * Embed research_pois rows missing content_embedding (M7).
 *
 * Resumable loop over rows where content_embedding IS NULL (also reset when
 * content_hash changes on re-extract). Only normalized POI rows are selected.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:embed [--source <slug>] [--limit N]
 *       [--batch-size N] [--throttle-ms N] [--dry-run]
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { ingestConfig } from "./config.js";
import { embedTexts, EmbedError } from "./providers/jina.js";

const DEFAULT_THROTTLE_MS = 200;

interface CliOptions {
  source?: string;
  limit?: number;
  batchSize: number;
  throttleMs: number;
  dryRun: boolean;
}

interface EmbedStats {
  selected: number;
  embedded: number;
  apiCalls: number;
  skippedEmpty: number;
}

interface EmbedRow {
  id: string;
  name: string | null;
  name_normalized: string | null;
  city: string | null;
  region: string | null;
  category_slugs: string[] | null;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let limit: number | undefined;
  let batchSize = ingestConfig.embed.batchSize;
  let throttleMs = DEFAULT_THROTTLE_MS;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (a === "--batch-size" && argv[i + 1]) batchSize = Number(argv[++i]);
    else if (a === "--throttle-ms" && argv[i + 1]) throttleMs = Number(argv[++i]);
  }

  for (const [name, val] of [
    ["--limit", limit],
    ["--batch-size", batchSize],
    ["--throttle-ms", throttleMs],
  ] as const) {
    if (val !== undefined && (!Number.isFinite(val) || val < 1)) {
      throw new Error(`Invalid ${name}: ${val}`);
    }
  }

  return { source, limit, batchSize, throttleMs, dryRun };
}

async function resolveSourceId(db: Pool, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM research_sources WHERE slug = $1`,
    [slug],
  );
  if (rows.length === 0) throw new Error(`Unknown source slug: ${slug}`);
  return rows[0]!.id;
}

/** Compose embed text: name + locality + primary category slug. */
export function buildEmbedText(row: EmbedRow): string | null {
  const primaryCategory = row.category_slugs?.[0] ?? null;
  const parts = [row.name_normalized, row.city, row.region, primaryCategory]
    .map((p) => (p ? p.trim() : ""))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return parts.join(" ");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function writeEmbedding(db: Pool, id: string, vector: number[]): Promise<void> {
  await db.query(`UPDATE research_pois SET content_embedding = $2 WHERE id = $1`, [id, vector]);
}

async function fetchRows(db: Pool, opts: CliOptions): Promise<EmbedRow[]> {
  const params: unknown[] = [];
  let where = `content_embedding IS NULL AND is_poi AND name_normalized IS NOT NULL`;
  if (opts.source) {
    params.push(await resolveSourceId(db, opts.source));
    where += ` AND source_id = $${params.length}`;
  }
  let limitClause = "";
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    limitClause = ` LIMIT $${params.length}`;
  }

  const { rows } = await db.query<EmbedRow>(
    `SELECT id, name, name_normalized, city, region, category_slugs
     FROM research_pois
     WHERE ${where}
     ORDER BY first_seen_at${limitClause}`,
    params,
  );
  return rows;
}

async function runEmbed(db: Pool, opts: CliOptions): Promise<EmbedStats> {
  const stats: EmbedStats = {
    selected: 0,
    embedded: 0,
    apiCalls: 0,
    skippedEmpty: 0,
  };

  const rows = await fetchRows(db, opts);
  stats.selected = rows.length;

  for (let i = 0; i < rows.length; i += opts.batchSize) {
    const batch = rows.slice(i, i + opts.batchSize);
    const work: { row: EmbedRow; text: string }[] = [];

    for (const row of batch) {
      const text = buildEmbedText(row);
      if (!text) {
        stats.skippedEmpty++;
        console.warn(`Skipped - ${row.name ?? `(id ${row.id})`} - nothing to embed`);
        continue;
      }
      work.push({ row, text });
    }

    if (work.length === 0) continue;

    if (opts.dryRun) {
      stats.apiCalls++;
      stats.embedded += work.length;
      continue;
    }

    if (stats.apiCalls > 0) await sleep(opts.throttleMs);

    let vectors: number[][];
    try {
      vectors = await embedTexts(work.map((w) => w.text));
    } catch (err) {
      if (err instanceof EmbedError) {
        console.error(`Stopping: ${err.message}`);
        break;
      }
      throw err;
    }
    stats.apiCalls++;

    for (let j = 0; j < work.length; j++) {
      await writeEmbedding(db, work[j]!.row.id, vectors[j]!);
      stats.embedded++;
      console.log(`✓ ${work[j]!.row.name ?? work[j]!.row.name_normalized}`);
    }
  }

  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const stats = await runEmbed(db, opts);
  await db.end();

  const mode = opts.dryRun ? " (dry-run)" : "";
  console.log(
    `Embed${mode}${opts.source ? ` ${opts.source}` : ""}: selected=${stats.selected} ` +
      `embedded=${stats.embedded} api_calls=${stats.apiCalls} skipped_empty=${stats.skippedEmpty}`,
  );
}

main().catch((err) => {
  console.error("Embed failed:", err);
  process.exit(1);
});
