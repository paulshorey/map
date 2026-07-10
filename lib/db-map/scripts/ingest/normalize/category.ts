/**
 * Strict category resolution (M5). The extractor records the developer-provided
 * `--category` slugs as ingest_categories (with the first as the primary
 * ingest_category); normalization verifies each slug still exists in
 * canonical_categories and writes the full set to category_slugs.
 */
import type { Pool } from "pg";

export async function loadValidSlugs(db: Pool): Promise<Set<string>> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT slug FROM canonical_categories`,
  );
  return new Set(rows.map((r) => r.slug));
}

/**
 * Validate and de-duplicate the developer-declared ingest categories against the
 * seeded taxonomy, preserving order (the first slug is the primary category).
 * Falls back to the scalar primary category when the array column is empty.
 */
export function resolveCategorySlugs(
  validSlugs: Set<string>,
  ingestCategories: readonly string[] | null | undefined,
  primaryCategory: string | null,
): string[] {
  const declared =
    ingestCategories && ingestCategories.length > 0
      ? [...ingestCategories]
      : primaryCategory
        ? [primaryCategory]
        : [];
  if (declared.length === 0) {
    throw new Error(
      "research_pois row is missing ingest categories; re-run extract with --category <slug>.",
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const slug of declared) {
    if (!validSlugs.has(slug)) {
      throw new Error(
        `Unknown ingest category "${slug}" on research_pois row; update taxonomy.ts and re-seed, or re-extract with the correct --category.`,
      );
    }
    if (!seen.has(slug)) {
      seen.add(slug);
      result.push(slug);
    }
  }
  return result;
}
