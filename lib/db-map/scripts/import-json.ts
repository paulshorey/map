/**
 * Import POIs from a JSON file. Designed for use with AI coding agents
 * that convert unstructured text into the structured NewPoi[] format.
 *
 * Usage:
 *   pnpm db:import:json <file.json> [--category "Flying Site"] [--replace] [--dry-run]
 *
 * The JSON file must contain an array of objects matching the NewPoi schema:
 *   [
 *     {
 *       "name": "Place Name",          // required
 *       "category": "Park",            // required (unless --category is used)
 *       "lng": -73.9654,               // required (longitude, -180 to 180)
 *       "lat": 40.7829,               // required (latitude, -90 to 90)
 *       "description": "...",          // optional
 *       "address": "...",              // optional
 *       "website": "https://...",      // optional
 *       "hours": "...",                // optional
 *       "photo_url": "https://..."     // optional
 *     }
 *   ]
 *
 * Options:
 *   --category <name>   Set category for POIs missing one, or override all categories
 *   --replace           Delete all existing POIs before importing
 *   --dry-run           Validate and print summary without writing to the database
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../lib/db/postgres.js";
import { insertPois, type NewPoi } from "../sql/pois.js";

interface ValidationError {
  index: number;
  name?: string;
  errors: string[];
}

const DATE_PRECISIONS = new Set(["datetime", "day", "month", "year"]);

/**
 * Validate an optional event-date field. Returns an ISO string (normalized to UTC) when valid,
 * null when absent, and pushes an error when present-but-unparseable.
 */
function parseEventDate(
  value: unknown,
  field: string,
  errors: string[],
): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    errors.push(`Invalid '${field}' (must be an ISO date string)`);
    return null;
  }
  const ms = Date.parse(value);
  if (isNaN(ms)) {
    errors.push(`Invalid '${field}': "${value}" is not a parseable date`);
    return null;
  }
  return new Date(ms).toISOString();
}

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = "";
  let category: string | undefined;
  let replace = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--category" && args[i + 1]) {
      category = args[++i]!;
    } else if (arg === "--replace") {
      replace = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (!arg.startsWith("--")) {
      filePath = arg;
    }
  }

  if (!filePath) {
    console.error(
      "Usage: pnpm db:import:json <file.json> [--category <name>] [--replace] [--dry-run]",
    );
    process.exit(1);
  }

  return { filePath: resolve(filePath), category, replace, dryRun };
}

function validatePoi(obj: unknown, index: number, defaultCategory?: string): { poi?: NewPoi; error?: ValidationError } {
  const errors: string[] = [];

  if (obj == null || typeof obj !== "object") {
    return { error: { index, errors: ["Not an object"] } };
  }

  const record = obj as Record<string, unknown>;

  if (typeof record.name !== "string" || !record.name.trim()) {
    errors.push("Missing or empty 'name'");
  }

  const category = (typeof record.category === "string" && record.category.trim())
    ? record.category.trim()
    : defaultCategory;

  if (!category) {
    errors.push("Missing or empty 'category' (provide per-item or use --category flag)");
  }

  if (typeof record.lng !== "number" || isNaN(record.lng)) {
    errors.push("Missing or invalid 'lng' (must be a number)");
  } else if (record.lng < -180 || record.lng > 180) {
    errors.push(`'lng' out of range: ${record.lng} (must be -180 to 180)`);
  }

  if (typeof record.lat !== "number" || isNaN(record.lat)) {
    errors.push("Missing or invalid 'lat' (must be a number)");
  } else if (record.lat < -90 || record.lat > 90) {
    errors.push(`'lat' out of range: ${record.lat} (must be -90 to 90)`);
  }

  // Optional event dates. Accept `starts_at`/`ends_at` or `start_date`/`end_date` aliases.
  const startsAt = parseEventDate(record.starts_at ?? record.start_date, "starts_at", errors);
  const endsAt = parseEventDate(record.ends_at ?? record.end_date, "ends_at", errors);

  let datePrecision: string | null = null;
  if (record.date_precision != null) {
    if (
      typeof record.date_precision === "string" &&
      DATE_PRECISIONS.has(record.date_precision)
    ) {
      datePrecision = record.date_precision;
    } else {
      errors.push(
        `Invalid 'date_precision' (must be one of: ${[...DATE_PRECISIONS].join(", ")})`,
      );
    }
  }

  if (errors.length > 0) {
    return { error: { index, name: record.name as string | undefined, errors } };
  }

  const poi: NewPoi = {
    name: (record.name as string).trim(),
    category: category!,
    lng: record.lng as number,
    lat: record.lat as number,
    description: typeof record.description === "string" ? record.description.trim() || null : null,
    address: typeof record.address === "string" ? record.address.trim() || null : null,
    website: typeof record.website === "string" ? record.website.trim() || null : null,
    hours: typeof record.hours === "string" ? record.hours.trim() || null : null,
    photo_url: typeof record.photo_url === "string" ? record.photo_url.trim() || null : null,
    starts_at: startsAt,
    ends_at: endsAt,
    date_precision: datePrecision,
  };

  return { poi };
}

async function main() {
  const { filePath, category, replace, dryRun } = parseArgs();

  console.log(`Reading JSON file: ${filePath}`);
  if (category) {
    console.log(`Default/override category: "${category}"`);
  }
  const raw = readFileSync(filePath, "utf-8");

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.error("Invalid JSON:", (err as Error).message);
    process.exit(1);
  }

  if (!Array.isArray(data)) {
    console.error("JSON must be an array of POI objects. Got:", typeof data);
    process.exit(1);
  }

  console.log(`Found ${data.length} entries in JSON file`);

  const valid: NewPoi[] = [];
  const validationErrors: ValidationError[] = [];

  for (let i = 0; i < data.length; i++) {
    const result = validatePoi(data[i], i, category);
    if (result.poi) {
      valid.push(result.poi);
    } else if (result.error) {
      validationErrors.push(result.error);
    }
  }

  if (validationErrors.length > 0) {
    console.warn(`\n⚠ ${validationErrors.length} entries failed validation:`);
    for (const err of validationErrors.slice(0, 20)) {
      const label = err.name ? `"${err.name}"` : `(index ${err.index})`;
      console.warn(`  [${err.index}] ${label}: ${err.errors.join("; ")}`);
    }
    if (validationErrors.length > 20) {
      console.warn(`  ... and ${validationErrors.length - 20} more`);
    }
  }

  console.log(`\nValid: ${valid.length} / ${data.length}`);

  if (valid.length === 0) {
    console.error("No valid POIs to import.");
    process.exit(1);
  }

  // Print category summary
  const categories = new Map<string, number>();
  for (const poi of valid) {
    categories.set(poi.category, (categories.get(poi.category) || 0) + 1);
  }
  console.log("\nCategories:");
  for (const [cat, count] of [...categories.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${cat}: ${count}`);
  }

  if (dryRun) {
    console.log("\n--- DRY RUN: First 3 POIs ---");
    for (const poi of valid.slice(0, 3)) {
      console.log(JSON.stringify(poi, null, 2));
    }
    console.log(`\nTotal: ${valid.length} POIs would be imported.`);
    return;
  }

  const result = await insertPois(getDb(), valid, { replace });

  // Final reconciliation report
  console.log("\n══════════════════════════════════════");
  console.log("  IMPORT RESULTS");
  console.log("══════════════════════════════════════");
  console.log(`  Total in file:        ${data.length}`);
  console.log(`  Passed validation:    ${valid.length}`);
  console.log(`  Failed validation:    ${validationErrors.length}`);
  console.log(`  Inserted to DB:       ${result.inserted}`);
  console.log(`  Failed DB insert:     ${result.failed.length}`);
  console.log("══════════════════════════════════════");

  if (result.failed.length > 0) {
    console.warn("\n⚠ The following POIs failed to insert:");
    for (const f of result.failed) {
      console.warn(`  [${f.index}] "${f.name}": ${f.error}`);
    }
  }

  if (result.inserted === valid.length) {
    console.log(`\n✓ All ${result.inserted} valid POIs were successfully inserted.${replace ? " (replaced existing data)" : ""}`);
  } else {
    console.warn(`\n⚠ Only ${result.inserted} of ${valid.length} valid POIs were inserted. Fix the failures above and re-import.`);
    process.exit(1);
  }

  await getDb().end();
}

main().catch((err) => {
  console.error("JSON import failed:", err);
  process.exit(1);
});
