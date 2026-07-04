import { execFileSync } from "node:child_process";
import process from "node:process";
import { Client } from "pg";

if (!process.env.DB_MAP_URL) {
  throw new Error("DB_MAP_URL is required");
}

function run(command, args) {
  execFileSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
}

function getScalar(rows, column) {
  return rows[0]?.[column];
}

run("node", ["scripts/migrate.mjs"]);
run("bash", ["scripts/snapshot-schema.sh"]);
run("node", ["scripts/generate-types.mjs"]);
run("node", ["scripts/generate-app-contract.mjs", "--write"]);

const client = new Client({ connectionString: process.env.DB_MAP_URL });
await client.connect();

// Two-layer schema (research_* raw + canonical_* published) — see the baseline migration.
const EXPECTED_TABLES = [
  "users",
  "user_preferences",
  "research_sources",
  "research_pois",
  "research_category_aliases",
  "research_match_decisions",
  "research_match_overrides",
  "research_geocode_cache",
  "canonical_categories",
  "canonical_pois",
  "canonical_poi_categories",
  "canonical_poi_occurrences",
];

const tablesResult = await client.query(
  `SELECT table_name
   FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = ANY($1)
   ORDER BY table_name`,
  [EXPECTED_TABLES],
);

const existingTables = new Set(tablesResult.rows.map((row) => row.table_name));
for (const table of EXPECTED_TABLES) {
  if (!existingTables.has(table)) {
    throw new Error(`Missing expected table: ${table}`);
  }
}

async function assertColumns(table, columns) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)`,
    [table, columns],
  );
  const present = new Set(result.rows.map((row) => row.column_name));
  for (const column of columns) {
    if (!present.has(column)) {
      throw new Error(`Missing expected column on ${table}: ${column}`);
    }
  }
}

// canonical_pois: user-facing place fields + denormalized primary category shortcut.
await assertColumns("canonical_pois", [
  "lng",
  "lat",
  "address",
  "website",
  "hours",
  "attributes",
  "popularity",
  "primary_category_id",
  "starts_at",
  "ends_at",
]);

// research_pois: raw fields + first-class derived category/validity columns.
await assertColumns("research_pois", [
  "source_id",
  "source_record_id",
  "name_normalized",
  "category_slugs",
  "is_poi",
  "content_hash",
  "canonical_poi_id",
  "content_embedding",
]);

async function assertConstraint(conname) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count FROM pg_constraint WHERE conname = $1`,
    [conname],
  );
  if (getScalar(result.rows, "count") < 1) {
    throw new Error(`Missing expected constraint: ${conname}`);
  }
}

await assertConstraint("users_tier_check");
await assertConstraint("user_preferences_user_id_fkey");
await assertConstraint("research_pois_source_id_source_record_id_key");
await assertConstraint("canonical_pois_primary_category_id_fkey");

async function assertIndex(indexname) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS count FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = $1`,
    [indexname],
  );
  if (getScalar(result.rows, "count") !== 1) {
    throw new Error(`Missing expected index: ${indexname}`);
  }
}

await assertIndex("canonical_pois_name_trgm");
await assertIndex("canonical_pois_primary_cat_idx");
await assertIndex("canonical_poi_categories_cat_idx");
await assertIndex("research_pois_category_slugs_gix");

const guestUserResult = await client.query(`
  SELECT COUNT(*)::int AS count
  FROM public.users
  WHERE id = 'guest'
`);

if (getScalar(guestUserResult.rows, "count") !== 1) {
  throw new Error("Missing expected guest user seed row");
}

await client.end();

run("git", [
  "diff",
  "--exit-code",
  "--",
  "schema/current.sql",
  "generated/contracts/map-app.json",
  "generated/typescript/db-types.ts",
  "generated/contracts/db-schema.json",
]);

console.log("Map DB contract verification passed");
