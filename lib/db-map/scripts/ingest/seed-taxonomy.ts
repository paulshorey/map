/**
 * Seed/refresh canonical_categories + research_category_aliases from the code-owned
 * taxonomy (taxonomy.ts). Idempotent: upserts by slug / alias, never duplicates.
 *
 * Usage: pnpm --filter @lib/db-map ingest:taxonomy:seed
 */
import { getDb } from "../../lib/db/postgres.js";
import { TAXONOMY } from "./taxonomy.js";

async function main() {
  const db = getDb();

  // Pass 1: upsert categories (without parent), capture slug → id.
  const idBySlug = new Map<string, string>();
  for (const c of TAXONOMY) {
    const { rows } = await db.query(
      `INSERT INTO canonical_categories (slug, display_name, sort_order, is_temporal)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         sort_order   = EXCLUDED.sort_order,
         is_temporal  = EXCLUDED.is_temporal
       RETURNING id`,
      [c.slug, c.display_name, c.sort_order ?? 0, c.is_temporal ?? false],
    );
    idBySlug.set(c.slug, rows[0].id as string);
  }

  // Pass 2: resolve parents.
  for (const c of TAXONOMY) {
    if (!c.parent) continue;
    const parentId = idBySlug.get(c.parent);
    if (!parentId) throw new Error(`Unknown parent "${c.parent}" for category "${c.slug}"`);
    await db.query(`UPDATE canonical_categories SET parent_id = $1 WHERE id = $2`, [
      parentId,
      idBySlug.get(c.slug),
    ]);
  }

  // Pass 3: aliases (global, source_id NULL).
  let aliasCount = 0;
  for (const c of TAXONOMY) {
    for (const alias of c.aliases ?? []) {
      await db.query(
        `INSERT INTO research_category_aliases (alias, category_id, source_id)
         VALUES ($1, $2, NULL)
         ON CONFLICT (alias, category_id) WHERE source_id IS NULL DO NOTHING`,
        [alias.toLowerCase(), idBySlug.get(c.slug)],
      );
      aliasCount++;
    }
  }

  const cats = await db.query(`SELECT count(*)::int n FROM canonical_categories`);
  console.log(`Seeded ${cats.rows[0].n} categories and ${aliasCount} aliases.`);
  await db.end();
}

main().catch((err) => {
  console.error("Taxonomy seed failed:", err);
  process.exit(1);
});
