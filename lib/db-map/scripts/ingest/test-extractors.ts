/**
 * Smoke-test garden extractors against the real dump files (one record each).
 * Usage: pnpm --filter @lib/db-map ingest:test-extractors
 */
import { resolve } from "node:path";
import { bgciExtractor } from "./extractors/bgci.js";
import { wikidataExtractor } from "./extractors/wikidata.js";
import { osmExtractor } from "./extractors/osm.js";
import { arbnetExtractor } from "./extractors/arbnet.js";
import { iabgExtractor } from "./extractors/iabg.js";
import { wikipediaUsExtractor } from "./extractors/wikipedia-us.js";
import { wikipediaIntlExtractor } from "./extractors/wikipedia-intl.js";
import { gardenologyExtractor } from "./extractors/gardenology.js";
import type { Extractor } from "./types.js";

const ROOT = resolve(import.meta.dirname, "../../../../docs/poi/botanical_gardens_data");

const CASES: Array<{ slug: string; file: string; extractor: Extractor }> = [
  { slug: "bgci", file: "bgci_gardens_full.json", extractor: bgciExtractor },
  { slug: "wikidata", file: "wikidata_botanical_gardens.json", extractor: wikidataExtractor },
  { slug: "osm", file: "osm_botanical_gardens.csv", extractor: osmExtractor },
  { slug: "arbnet", file: "arbnet_morton_register.json", extractor: arbnetExtractor },
  { slug: "iabg", file: "iabg_checklist_gardens.json", extractor: iabgExtractor },
  { slug: "wikipedia_us", file: "wikipedia_us_gardens.json", extractor: wikipediaUsExtractor },
  { slug: "wikipedia_intl", file: "wikipedia_intl_gardens.json", extractor: wikipediaIntlExtractor },
  { slug: "gardenology", file: "gardenology_us_gardens.json", extractor: gardenologyExtractor },
];

async function testExtractor(slug: string, file: string, extractor: Extractor): Promise<void> {
  const path = resolve(ROOT, file);
  let record;
  for await (const r of extractor.parse(path)) {
    record = r;
    break;
  }
  if (!record) throw new Error(`${slug}: no records parsed from ${file}`);
  if (!record.source_record_id) {
    throw new Error(`${slug}: missing source_record_id`);
  }
  if (!record.name) {
    throw new Error(`${slug}: missing name on ${record.source_record_id}`);
  }
  console.log(`  ✓ ${slug}: ${record.source_record_id} — ${record.name}`);
}

async function main() {
  console.log("Extractor smoke tests:");
  for (const c of CASES) {
    await testExtractor(c.slug, c.file, c.extractor);
  }
  console.log(`All ${CASES.length} extractors passed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
