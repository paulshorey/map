import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { PURGED_TABLES } from "./purge.js";

// Tables deliberately kept by a purge; every other table in the schema must be purged.
const KEPT = new Set([
  "research_geocode_cache",
  "research_provider_daily_usage",
  "canonical_categories",
  "users",
  "user_preferences",
  "research_ingest_control",
  "research_ingest_control_events",
  "research_ingest_inventory",
  "research_ingest_inventory_edits",
  "research_ingest_inventory_scans",
  "research_ingest_inventory_versions",
  "research_sources",
  "geo_centroids",
  "schema_migrations_cursor",
]);

test("purge covers every schema table except the deliberately kept ones", () => {
  const sql = readdirSync(new URL("../../schema/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(new URL(`../../schema/${f}`, import.meta.url), "utf8"))
    .join("\n");
  const tables = [...sql.matchAll(/CREATE TABLE (?:public\.)?"?([a-z_]+)"?/gi)].map((m) => m[1]!);
  assert.ok(tables.length > 20, "schema snapshot found");
  const purged = new Set<string>(PURGED_TABLES);
  for (const table of tables)
    assert.ok(purged.has(table) || KEPT.has(table), `${table} is neither purged nor kept`);
  for (const table of purged) assert.ok(tables.includes(table), `${table} not in schema`);
});
