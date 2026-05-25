/**
 * Import POIs from a KML file (e.g. exported from Google Maps "My Maps").
 *
 * Usage:
 *   pnpm db:import:kml <file.kml> [--category "Flying Site"] [--replace] [--dry-run]
 *
 * Options:
 *   --category <name>   Override category for all imported POIs (default: uses KML folder name or "Uncategorized")
 *   --replace           Delete all existing POIs before importing
 *   --dry-run           Parse and print POIs without writing to the database
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { getDb } from "../lib/db/postgres.js";
import { insertPois, type NewPoi } from "../sql/pois.js";

interface KmlPlacemark {
  name?: string;
  description?: string;
  Point?: { coordinates: string };
  ExtendedData?: {
    Data?: KmlDataField | KmlDataField[];
  };
}

interface KmlDataField {
  "@_name": string;
  value: string | number;
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
      "Usage: pnpm db:import:kml <file.kml> [--category <name>] [--replace] [--dry-run]",
    );
    process.exit(1);
  }

  return { filePath: resolve(filePath), category, replace, dryRun };
}

function stripCdata(text: unknown): string {
  if (typeof text !== "string") return "";
  return text.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "");
}

function parseCoordinates(coordStr: string): { lng: number; lat: number } | null {
  const cleaned = coordStr.trim();
  const parts = cleaned.split(",");
  if (parts.length < 2) return null;

  const lng = parseFloat(parts[0]!);
  const lat = parseFloat(parts[1]!);

  if (isNaN(lng) || isNaN(lat)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lng, lat };
}

function getExtendedDataMap(placemark: KmlPlacemark): Map<string, string> {
  const map = new Map<string, string>();
  const data = placemark.ExtendedData?.Data;
  if (!data) return map;

  const fields = Array.isArray(data) ? data : [data];
  for (const field of fields) {
    if (field["@_name"] && field.value != null) {
      map.set(field["@_name"], String(field.value));
    }
  }
  return map;
}

function buildDescription(
  rawDescription: string,
  extData: Map<string, string>,
): string {
  // KML descriptions from Google Maps are often HTML with <br> tags
  // containing structured key: value pairs. Clean it up.
  if (rawDescription) {
    return rawDescription
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .trim();
  }

  // Fall back to ExtendedData fields as a description
  if (extData.size > 0) {
    const parts: string[] = [];
    for (const [key, val] of extData) {
      if (!key.toLowerCase().includes("latitude") && !key.toLowerCase().includes("longitude")) {
        parts.push(`${key}: ${val}`);
      }
    }
    return parts.join("\n");
  }

  return "";
}

function extractWebsite(extData: Map<string, string>, description: string): string | null {
  // Check ExtendedData for website-like fields
  for (const [key, val] of extData) {
    const k = key.toLowerCase();
    if (k.includes("website") || k.includes("url") || k.includes("link")) {
      if (val.startsWith("http")) return val;
    }
  }

  // Try to find a URL in the description
  const urlMatch = description.match(/https?:\/\/[^\s<>"]+/);
  return urlMatch ? urlMatch[0] : null;
}

function extractAddress(extData: Map<string, string>): string | null {
  const city = extData.get("Location City") || extData.get("City") || "";
  const state = extData.get("Location State") || extData.get("State") || "";

  if (city || state) {
    return [city, state].filter(Boolean).join(", ");
  }

  // Check for an address field
  for (const [key, val] of extData) {
    if (key.toLowerCase().includes("address")) return val;
  }

  return null;
}

function placemarkToPoi(
  placemark: KmlPlacemark,
  defaultCategory: string,
): NewPoi | null {
  const name = stripCdata(placemark.name)?.trim();
  if (!name) return null;

  const coordStr = placemark.Point?.coordinates;
  if (!coordStr) return null;

  const coords = parseCoordinates(typeof coordStr === "string" ? coordStr : String(coordStr));
  if (!coords) return null;

  const extData = getExtendedDataMap(placemark);
  const rawDesc = stripCdata(placemark.description);
  const description = buildDescription(rawDesc, extData) || null;
  const website = extractWebsite(extData, rawDesc);
  const address = extractAddress(extData);

  return {
    name,
    category: defaultCategory,
    description,
    address,
    website,
    hours: null,
    photo_url: null,
    lng: coords.lng,
    lat: coords.lat,
  };
}

function collectPlacemarks(obj: unknown, results: KmlPlacemark[]): void {
  if (obj == null || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) collectPlacemarks(item, results);
    return;
  }

  const record = obj as Record<string, unknown>;

  if ("Point" in record && "name" in record) {
    results.push(record as unknown as KmlPlacemark);
    return;
  }

  for (const val of Object.values(record)) {
    collectPlacemarks(val, results);
  }
}

function getFolderName(parsed: unknown): string {
  // Try to extract the first Folder name from the KML document
  const doc = (parsed as Record<string, unknown>)?.kml as Record<string, unknown> | undefined;
  const document = doc?.Document as Record<string, unknown> | undefined;
  const folder = document?.Folder as Record<string, unknown> | undefined;
  if (folder?.name && typeof folder.name === "string") {
    return folder.name;
  }
  return "Uncategorized";
}

async function main() {
  const { filePath, category, replace, dryRun } = parseArgs();

  console.log(`Reading KML file: ${filePath}`);
  const xml = readFileSync(filePath, "utf-8");

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    cdataPropName: false,
    parseTagValue: true,
    parseAttributeValue: true,
    trimValues: true,
    processEntities: true,
  });

  const parsed = parser.parse(xml);
  const defaultCategory = category || getFolderName(parsed);

  const placemarks: KmlPlacemark[] = [];
  collectPlacemarks(parsed, placemarks);

  console.log(`Found ${placemarks.length} placemarks in KML`);

  const pois: NewPoi[] = [];
  const skipped: string[] = [];

  for (const pm of placemarks) {
    const poi = placemarkToPoi(pm, defaultCategory);
    if (poi) {
      pois.push(poi);
    } else {
      skipped.push(stripCdata(pm.name) || "(unnamed)");
    }
  }

  console.log(`Parsed ${pois.length} valid POIs (skipped ${skipped.length})`);

  if (skipped.length > 0 && skipped.length <= 10) {
    console.log("Skipped:", skipped.join(", "));
  }

  if (dryRun) {
    console.log("\n--- DRY RUN: First 5 POIs ---");
    for (const poi of pois.slice(0, 5)) {
      console.log(JSON.stringify(poi, null, 2));
    }
    console.log(`\nTotal: ${pois.length} POIs would be imported.`);
    return;
  }

  const result = await insertPois(getDb(), pois, { replace });

  console.log(`\nInserted ${result.inserted} POIs into the database.${replace ? " (replaced existing data)" : ""}`);
  if (result.failed.length > 0) {
    console.warn(`⚠ ${result.failed.length} POIs failed to insert:`);
    for (const f of result.failed) {
      console.warn(`  [${f.index}] "${f.name}": ${f.error}`);
    }
  }
  await getDb().end();
}

main().catch((err) => {
  console.error("KML import failed:", err);
  process.exit(1);
});
