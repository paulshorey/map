/**
 * Geocode research_pois rows missing coordinates (M6).
 *
 * Automatic + conditional: selects only rows where lat IS NULL (the source had no
 * coordinates). Rows that already carry coordinates are never touched — existing
 * coordinates are trusted, so they cost zero API calls.
 *
 * Idempotent + resumable + budgeted:
 *   - research_geocode_cache dedupes identical queries and remembers misses.
 *   - Only cache MISSES call the API and count against --geocode-limit (default 4500).
 *   - When the budget is hit the step just stops; un-reached rows stay lat IS NULL
 *     and the same command resumes them next run.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:geocode [--source <slug>] [--limit N]
 *       [--geocode-limit N] [--throttle-ms N] [--dry-run]
 */
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import { geocode, GeocodeError, type GeocodeHit } from "./providers/locationiq.js";

const DEFAULT_GEOCODE_LIMIT = 4500;
const DEFAULT_THROTTLE_MS = 1000; // LocationIQ free tier: stay comfortably under 2 req/s.

interface CliOptions {
  source?: string;
  limit?: number;
  geocodeLimit: number;
  throttleMs: number;
  dryRun: boolean;
}

interface GeocodeStats {
  selected: number;
  cacheHits: number;
  knownMisses: number;
  apiCalls: number;
  resolved: number;
  unresolved: number;
  noQuery: number;
  budgetHit: boolean;
}

interface GeoRow {
  id: string;
  name: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  country_name: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let source: string | undefined;
  let limit: number | undefined;
  let geocodeLimit = DEFAULT_GEOCODE_LIMIT;
  let throttleMs = DEFAULT_THROTTLE_MS;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--source" && argv[i + 1]) source = argv[++i];
    else if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else if (a === "--geocode-limit" && argv[i + 1]) geocodeLimit = Number(argv[++i]);
    else if (a === "--throttle-ms" && argv[i + 1]) throttleMs = Number(argv[++i]);
  }

  for (const [name, val] of [
    ["--limit", limit],
    ["--geocode-limit", geocodeLimit],
    ["--throttle-ms", throttleMs],
  ] as const) {
    if (val !== undefined && (!Number.isFinite(val) || val < 0)) {
      throw new Error(`Invalid ${name}: ${val}`);
    }
  }

  return { source, limit, geocodeLimit, throttleMs, dryRun };
}

async function resolveSourceId(db: Pool, slug: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM research_sources WHERE slug = $1`,
    [slug],
  );
  if (rows.length === 0) throw new Error(`Unknown source slug: ${slug}`);
  return rows[0]!.id;
}

/** Build the geocode query text + a normalized cache key from a row's locality. */
function buildQuery(row: GeoRow): { display: string; norm: string } | null {
  const parts = [row.name, row.city, row.region, row.country_name ?? row.country_code]
    .map((p) => (p ? p.trim() : ""))
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const display = parts.join(", ");
  const norm = display
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { display, norm };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readCache(
  db: Pool,
  norm: string,
): Promise<{ lat: number | null; lng: number | null } | undefined> {
  const { rows } = await db.query<{ lat: number | null; lng: number | null }>(
    `SELECT lat, lng FROM research_geocode_cache WHERE query_norm = $1`,
    [norm],
  );
  return rows[0];
}

async function writeCache(db: Pool, norm: string, hit: GeocodeHit | null): Promise<void> {
  await db.query(
    `INSERT INTO research_geocode_cache (query_norm, lat, lng, precision, provider)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (query_norm) DO UPDATE SET
       lat = EXCLUDED.lat, lng = EXCLUDED.lng,
       precision = EXCLUDED.precision, provider = EXCLUDED.provider,
       fetched_at = now()`,
    [norm, hit?.lat ?? null, hit?.lng ?? null, hit?.precision ?? null, hit?.provider ?? "locationiq"],
  );
}

async function writeRowCoords(db: Pool, id: string, lat: number, lng: number): Promise<void> {
  await db.query(`UPDATE research_pois SET lat = $2, lng = $3 WHERE id = $1`, [id, lat, lng]);
}

async function runGeocode(db: Pool, opts: CliOptions): Promise<GeocodeStats> {
  const stats: GeocodeStats = {
    selected: 0,
    cacheHits: 0,
    knownMisses: 0,
    apiCalls: 0,
    resolved: 0,
    unresolved: 0,
    noQuery: 0,
    budgetHit: false,
  };

  const params: unknown[] = [];
  let where = `lat IS NULL AND is_poi`;
  if (opts.source) {
    params.push(await resolveSourceId(db, opts.source));
    where += ` AND source_id = $${params.length}`;
  }
  let limitClause = "";
  if (opts.limit !== undefined) {
    params.push(opts.limit);
    limitClause = ` LIMIT $${params.length}`;
  }

  const { rows } = await db.query<GeoRow>(
    `SELECT id, name, city, region, country_code,
            attributes->>'country_name' AS country_name
     FROM research_pois
     WHERE ${where}
     ORDER BY first_seen_at${limitClause}`,
    params,
  );
  stats.selected = rows.length;

  for (const row of rows) {
    const q = buildQuery(row);
    if (!q) {
      stats.noQuery++;
      continue;
    }

    const cached = await readCache(db, q.norm);
    if (cached) {
      if (cached.lat !== null && cached.lng !== null) {
        if (!opts.dryRun) await writeRowCoords(db, row.id, cached.lat, cached.lng);
        stats.cacheHits++;
        stats.resolved++;
      } else {
        stats.knownMisses++;
      }
      continue;
    }

    // Cache miss → an API call is required.
    if (stats.apiCalls >= opts.geocodeLimit) {
      stats.budgetHit = true;
      break;
    }

    if (opts.dryRun) {
      // Count as an intended call but do not hit the network.
      stats.apiCalls++;
      continue;
    }

    await sleep(opts.throttleMs);
    let hit: GeocodeHit | null;
    try {
      hit = await geocode(q.display);
    } catch (err) {
      if (err instanceof GeocodeError) {
        console.error(`Stopping: ${err.message} (query: ${q.display})`);
        break;
      }
      throw err;
    }
    stats.apiCalls++;

    await writeCache(db, q.norm, hit);
    if (hit) {
      await writeRowCoords(db, row.id, hit.lat, hit.lng);
      stats.resolved++;
    } else {
      stats.unresolved++;
    }
  }

  return stats;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const stats = await runGeocode(db, opts);
  await db.end();

  const mode = opts.dryRun ? " (dry-run)" : "";
  console.log(
    `Geocode${mode}${opts.source ? ` ${opts.source}` : ""}: selected=${stats.selected} ` +
      `cache_hits=${stats.cacheHits} known_misses=${stats.knownMisses} ` +
      `api_calls=${stats.apiCalls} resolved=${stats.resolved} unresolved=${stats.unresolved} ` +
      `no_query=${stats.noQuery}${stats.budgetHit ? " [budget reached — re-run to continue]" : ""}`,
  );
}

main().catch((err) => {
  console.error("Geocode failed:", err);
  process.exit(1);
});
