/**
 * Category alias resolution (M5). Loads research_category_aliases → canonical
 * slug map and resolves a research row's raw/ingest category to canonical slugs.
 */
import type { Pool } from "pg";

export type AliasMap = Map<string, string[]>;

export async function loadAliasMap(db: Pool): Promise<AliasMap> {
  const { rows } = await db.query<{ alias: string; slug: string }>(
    `SELECT a.alias, c.slug
     FROM research_category_aliases a
     JOIN canonical_categories c ON c.id = a.category_id
     WHERE a.source_id IS NULL`,
  );
  const map: AliasMap = new Map();
  for (const r of rows) {
    const key = r.alias.toLowerCase();
    const list = map.get(key) ?? [];
    if (!list.includes(r.slug)) list.push(r.slug);
    map.set(key, list);
  }
  return map;
}

export async function loadValidSlugs(db: Pool): Promise<Set<string>> {
  const { rows } = await db.query<{ slug: string }>(
    `SELECT slug FROM canonical_categories`,
  );
  return new Set(rows.map((r) => r.slug));
}

/**
 * Resolve canonical category slugs for a row. Tries the raw category string
 * against aliases first; falls back to the dump-level ingest_category slug
 * (which is authored in taxonomy.ts, so it is already canonical).
 */
export function resolveCategorySlugs(
  aliasMap: AliasMap,
  validSlugs: Set<string>,
  rawCategory: string | null,
  ingestCategory: string | null,
): { slugs: string[]; unmapped: string | null } {
  const slugs = new Set<string>();
  let unmapped: string | null = null;

  if (rawCategory) {
    const hit = aliasMap.get(rawCategory.toLowerCase());
    if (hit) {
      for (const s of hit) slugs.add(s);
    } else {
      unmapped = rawCategory;
    }
  }

  if (ingestCategory && validSlugs.has(ingestCategory)) {
    slugs.add(ingestCategory);
  }

  return { slugs: [...slugs], unmapped };
}
