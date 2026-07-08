/**
 * Seed GeoNames city/country centroid references.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:seed:centroids [--limit N]
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { getDb } from "../../lib/db/postgres.js";

interface CliOptions {
  limit?: number;
}

interface CentroidSeed {
  id: number;
  kind: "city" | "country";
  name: string;
  admin1: string | null;
  countryCode: string | null;
  population: number | null;
  lat: number;
  lng: number;
}

function parseArgs(argv: string[]): CliOptions {
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" && argv[i + 1]) limit = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`Invalid --limit: ${limit}`);
  }
  return { limit };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../../data/geonames");
const BATCH_SIZE = 1000;

async function flush(db: ReturnType<typeof getDb>, batch: CentroidSeed[]): Promise<void> {
  if (batch.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  for (const row of batch) {
    const base = params.length;
    params.push(row.id, row.kind, row.name, row.admin1, row.countryCode, row.population, row.lat, row.lng);
    values.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8})`,
    );
  }
  await db.query(
    `INSERT INTO geo_centroids (id, kind, name, admin1, country_code, population, lat, lng)
     VALUES ${values.join(",")}
     ON CONFLICT (id) DO UPDATE SET
       kind = EXCLUDED.kind,
       name = EXCLUDED.name,
       admin1 = EXCLUDED.admin1,
       country_code = EXCLUDED.country_code,
       population = EXCLUDED.population,
       lat = EXCLUDED.lat,
       lng = EXCLUDED.lng`,
    params,
  );
  batch.length = 0;
}

async function seedCities(db: ReturnType<typeof getDb>, opts: CliOptions): Promise<number> {
  const file = path.join(DATA_DIR, "cities500.txt");
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  const batch: CentroidSeed[] = [];
  let count = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const id = Number(cols[0]);
    const lat = Number(cols[4]);
    const lng = Number(cols[5]);
    if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    batch.push({
      id,
      kind: "city",
      name: cols[1] || cols[2] || String(id),
      admin1: cols[10] || null,
      countryCode: cols[8] || null,
      population: cols[14] ? Number(cols[14]) : null,
      lat,
      lng,
    });
    count++;
    if (batch.length >= BATCH_SIZE) await flush(db, batch);
    if (opts.limit !== undefined && count >= opts.limit) break;
  }
  await flush(db, batch);
  return count;
}

async function seedCountries(db: ReturnType<typeof getDb>, opts: CliOptions): Promise<number> {
  const file = path.join(DATA_DIR, "countries360-2024.csv");
  const records = parse(fs.readFileSync(file, "utf8"), {
    columns: true,
    skip_empty_lines: true,
  }) as Array<{ iso3?: string; name?: string; lat?: string; lon?: string }>;
  const batch: CentroidSeed[] = [];
  let count = 0;
  for (const [idx, record] of records.entries()) {
    const lat = Number(record.lat);
    const lng = Number(record.lon);
    if (!record.iso3 || !record.name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    batch.push({
      id: -(idx + 1),
      kind: "country",
      name: record.name,
      admin1: null,
      countryCode: record.iso3,
      population: null,
      lat,
      lng,
    });
    count++;
    if (batch.length >= BATCH_SIZE) await flush(db, batch);
    if (opts.limit !== undefined && count >= opts.limit) break;
  }
  await flush(db, batch);
  return count;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const db = getDb();
  const cities = await seedCities(db, opts);
  const countries = await seedCountries(db, opts.limit === undefined ? {} : { limit: opts.limit });
  await db.end();
  console.log(`Seeded geo_centroids: cities=${cities} countries=${countries}`);
}

main().catch((err) => {
  console.error("Centroid seed failed:", err);
  process.exit(1);
});
