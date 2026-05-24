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

const tablesResult = await client.query(`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('pois', 'users', 'user_preferences')
  ORDER BY table_name
`);

const existingTables = new Set(tablesResult.rows.map((row) => row.table_name));
for (const table of ["pois", "users", "user_preferences"]) {
  if (!existingTables.has(table)) {
    throw new Error(`Missing expected table: ${table}`);
  }
}

const poisColumnsResult = await client.query(`
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'pois'
    AND column_name IN ('lng', 'lat')
  ORDER BY column_name
`);

if (poisColumnsResult.rowCount !== 2) {
  throw new Error("Missing expected columns on pois: lng, lat");
}

const usersTierCheckResult = await client.query(`
  SELECT COUNT(*)::int AS count
  FROM pg_constraint
  WHERE conname = 'users_tier_check'
`);

if (getScalar(usersTierCheckResult.rows, "count") !== 1) {
  throw new Error("Missing expected check constraint: users_tier_check");
}

const userPreferencesFkResult = await client.query(`
  SELECT COUNT(*)::int AS count
  FROM pg_constraint
  WHERE conname = 'user_preferences_user_id_fkey'
`);

if (getScalar(userPreferencesFkResult.rows, "count") !== 1) {
  throw new Error(
    "Missing expected foreign key constraint: user_preferences_user_id_fkey",
  );
}

const poiCoordsIndexResult = await client.query(`
  SELECT COUNT(*)::int AS count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'pois_coords_idx'
`);

if (getScalar(poiCoordsIndexResult.rows, "count") !== 1) {
  throw new Error("Missing expected index: pois_coords_idx");
}

const poiCategoryIndexResult = await client.query(`
  SELECT COUNT(*)::int AS count
  FROM pg_indexes
  WHERE schemaname = 'public'
    AND indexname = 'pois_category_idx'
`);

if (getScalar(poiCategoryIndexResult.rows, "count") !== 1) {
  throw new Error("Missing expected index: pois_category_idx");
}

const poiDetailColumnsResult = await client.query(`
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'pois'
    AND column_name IN ('address', 'website', 'hours')
  ORDER BY column_name
`);

const existingPoiDetailColumns = new Set(
  poiDetailColumnsResult.rows.map((row) => row.column_name),
);

for (const column of ["address", "website", "hours"]) {
  if (!existingPoiDetailColumns.has(column)) {
    throw new Error(`Missing expected column on pois: ${column}`);
  }
}

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
