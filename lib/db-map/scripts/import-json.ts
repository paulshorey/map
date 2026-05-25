/**
 * Import POIs from a JSON file. Designed for use with AI coding agents
 * that convert unstructured text into the structured NewPoi[] format.
 *
 * Usage:
 *   pnpm db:import:json <file.json> [--replace] [--dry-run]
 *
 * The JSON file must contain an array of objects matching the NewPoi schema:
 *   [
 *     {
 *       "name": "Place Name",          // required
 *       "category": "Park",            // required
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
 *   --replace   Delete all existing POIs before importing
 *   --dry-run   Validate and print summary without writing to the database
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

function parseArgs() {
  const args = process.argv.slice(2);
  let filePath = "";
  let replace = false;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--replace") {
      replace = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (!arg.startsWith("--")) {
      filePath = arg;
    }
  }

  if (!filePath) {
    console.error(
      "Usage: pnpm db:import:json <file.json> [--replace] [--dry-run]",
    );
    process.exit(1);
  }

  return { filePath: resolve(filePath), replace, dryRun };
}

function validatePoi(obj: unknown, index: number): { poi?: NewPoi; error?: ValidationError } {
  const errors: string[] = [];

  if (obj == null || typeof obj !== "object") {
    return { error: { index, errors: ["Not an object"] } };
  }

  const record = obj as Record<string, unknown>;

  if (typeof record.name !== "string" || !record.name.trim()) {
    errors.push("Missing or empty 'name'");
  }

  if (typeof record.category !== "string" || !record.category.trim()) {
    errors.push("Missing or empty 'category'");
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

  if (errors.length > 0) {
    return { error: { index, name: record.name as string | undefined, errors } };
  }

  const poi: NewPoi = {
    name: (record.name as string).trim(),
    category: (record.category as string).trim(),
    lng: record.lng as number,
    lat: record.lat as number,
    description: typeof record.description === "string" ? record.description.trim() || null : null,
    address: typeof record.address === "string" ? record.address.trim() || null : null,
    website: typeof record.website === "string" ? record.website.trim() || null : null,
    hours: typeof record.hours === "string" ? record.hours.trim() || null : null,
    photo_url: typeof record.photo_url === "string" ? record.photo_url.trim() || null : null,
  };

  return { poi };
}

async function main() {
  const { filePath, replace, dryRun } = parseArgs();

  console.log(`Reading JSON file: ${filePath}`);
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
    const result = validatePoi(data[i], i);
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

  const count = await insertPois(getDb(), valid, { replace });
  console.log(
    `\nInserted ${count} POIs into the database.${replace ? " (replaced existing data)" : ""}`,
  );
  await getDb().end();
}

main().catch((err) => {
  console.error("JSON import failed:", err);
  process.exit(1);
});
