/**
 * Strict category resolution (M5). The extractor records the developer-provided
 * `--category` slug as ingest_category; normalization verifies that slug still
 * exists in canonical_categories and writes it to category_slugs.
 */
import type { Pool } from "pg";

export async function loadValidSlugs(db: Pool): Promise<Set<string>> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT slug FROM canonical_categories`,
  );
  return new Set(rows.map((r) => r.slug));
}

export function resolveCategorySlugs(
  validSlugs: Set<string>,
  ingestCategory: string | null,
): string[] {
  if (!ingestCategory) {
    throw new Error("research_pois row is missing ingest_category; re-run extract with --category <slug>.");
  }
  if (!validSlugs.has(ingestCategory)) {
    throw new Error(
      `Unknown ingest_category "${ingestCategory}" on research_pois row; update taxonomy.ts and re-seed, or re-extract with the correct --category.`,
    );
  }
  return [ingestCategory];
}
