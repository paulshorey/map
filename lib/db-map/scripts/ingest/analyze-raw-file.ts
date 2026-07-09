/**
 * Offline audit of a capture-spec JSON file BEFORE import.
 * Estimates how many rows will need LLM enrichment.
 *
 * Usage:
 *   pnpm --filter @lib/db-map ingest:analyze-raw <file.json> [--category <slug>]
 */
import { readFile } from "node:fs/promises";

interface CliOptions {
  file: string;
  category?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const file = positional[0];
  if (!file) throw new Error("Usage: ingest:analyze-raw <file.json> [--category <slug>]");
  let category: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--category" && argv[i + 1]) category = argv[++i];
  }
  return { file, category };
}

function isTemporal(category: string | undefined): boolean {
  if (!category) return false;
  return ["music_festival", "carnival", "art_fair"].includes(category);
}

function pct(n: number, total: number): string {
  if (total === 0) return "0%";
  return `${((n / total) * 100).toFixed(0)}%`;
}

function str(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function hasEditionYear(name: string): boolean {
  return /\b20\d{2}\b/.test(name);
}

function looksLikeStreetCity(city: string): boolean {
  return /\d/.test(city) && /(st|street|ave|road|rd|blvd|way|pkwy|weg|straße|strasse)/i.test(city);
}

function countryLooksWrong(country: string | null): boolean {
  if (!country) return false;
  const c = country.trim();
  if (/^[A-Z]{2}$/.test(c) && !["US", "GB", "DE", "FR", "AU", "CA", "NL", "ES", "IT"].includes(c)) {
    // US states often appear as 2-letter
    const usStates = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"]);
    return usStates.has(c);
  }
  return false;
}

async function loadRecords(file: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(file, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    for (const key of ["festivals", "records", "data", "items", "results"]) {
      if (Array.isArray(obj[key])) {
        console.warn(`Note: wrapper object detected — unwrapped "${key}" array (${(obj[key] as unknown[]).length} rows). Needs custom extractor.`);
        return obj[key] as Record<string, unknown>[];
      }
    }
  }
  throw new Error("Expected top-level JSON array or known wrapper key");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const records = await loadRecords(opts.file);
  const temporal = isTemporal(opts.category);
  const total = records.length;

  let missingName = 0;
  let editionYear = 0;
  let missingCountry = 0;
  let badCountry = 0;
  let missingCity = 0;
  let streetCity = 0;
  let missingDates = 0;
  let proseDates = 0;
  let wrapper = 0;
  let notFestival = 0;
  let wouldEnrich = 0;

  for (const row of records) {
    const name = str(row.name);
    if (!name) {
      missingName++;
      continue;
    }
    const city = str(row.city);
    const country = str(row.country ?? row.country_name);
    const location = str(row.location ?? row.location_raw);
    const start = str(row.start_date);
    const end = str(row.end_date);
    const dates = str(row.dates ?? row.date_text ?? row.date_raw);

    const flags: string[] = [];
    if (temporal && hasEditionYear(name)) { editionYear++; flags.push("edition_year"); }
    if (!row.country_code && country) { missingCountry++; flags.push("country"); }
    if (countryLooksWrong(country)) { badCountry++; flags.push("bad_country"); }
    if (!city && (location || row.venue)) { missingCity++; flags.push("missing_city"); }
    if (city && looksLikeStreetCity(city)) { streetCity++; flags.push("street_city"); }
    if (temporal && !start && !end && dates) { proseDates++; flags.push("prose_dates"); }
    if (temporal && !start && !end && !dates) { missingDates++; flags.push("missing_dates"); }
    if (row.is_festival === false) { notFestival++; flags.push("not_festival"); }
    if (name.toLowerCase() === "events" || name.toLowerCase() === "test") { wrapper++; flags.push("nav_page"); }

    if (flags.length > 0) wouldEnrich++;
  }

  console.log(`\n# Raw file analysis: ${opts.file}`);
  console.log(`Records: ${total}${opts.category ? `  category=${opts.category}` : ""}`);
  console.log(`Estimated LLM enrichment candidates: ${wouldEnrich} (${pct(wouldEnrich, total)})`);

  const metrics: [string, number][] = [
    ["missing name", missingName],
    ["edition year in name", editionYear],
    ["country text, no country_code", missingCountry],
    ["US-state-as-country pattern", badCountry],
    ["missing city (has location/venue)", missingCity],
    ["street-like city", streetCity],
    ["prose dates only", proseDates],
    ["temporal, no dates at all", missingDates],
    ["is_festival=false", notFestival],
    ["nav/test page names", wrapper],
  ];
  console.log("\n## Signals");
  for (const [label, n] of metrics) {
    if (n > 0) console.log(`  ${label.padEnd(32)} ${String(n).padStart(6)}  (${pct(n, total)})`);
  }
}

main().catch((err) => {
  console.error("analyze-raw-file failed:", err);
  process.exit(1);
});
