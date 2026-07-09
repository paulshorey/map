/**
 * Code-owned POI category taxonomy (overview Decision 5).
 *
 * This is the single source of truth for canonical categories, their hierarchy, and
 * which ones are temporal (events). Ingestion is strict: the developer passes one
 * canonical slug via `--category`, and unknown slugs fail before anything is written.
 * Edit here, then run `pnpm --filter @lib/db-map ingest:taxonomy:seed` to project it into
 * `canonical_categories`.
 */

export interface CategorySeed {
  slug: string;
  display_name: string;
  parent?: string;
  sort_order?: number;
  is_temporal?: boolean;
}

export const TAXONOMY: CategorySeed[] = [
  // ── General places (used by the current example/seed data) ──
  { slug: "park", display_name: "Park", sort_order: 10 },
  { slug: "historic_site", display_name: "Historic Site", sort_order: 20 },
  { slug: "museum", display_name: "Museum", sort_order: 30 },
  { slug: "viewpoint", display_name: "Viewpoint", sort_order: 40 },
  { slug: "restaurant", display_name: "Restaurant", sort_order: 50 },
  { slug: "shop", display_name: "Shop", sort_order: 60 },
  { slug: "cafe", display_name: "Cafe", sort_order: 70 },
  { slug: "beach", display_name: "Beach", sort_order: 80 },
  { slug: "trail", display_name: "Trail", sort_order: 90 },

  // ── Events (temporal) — one top-level category per docs/poi folder ──
  {
    slug: "music_festival",
    display_name: "Music Festival",
    sort_order: 100,
    is_temporal: true,
  },
  {
    slug: "carnival",
    display_name: "Carnival",
    sort_order: 101,
    is_temporal: true,
  },
  {
    slug: "art_fair",
    display_name: "Art Fair",
    sort_order: 102,
    is_temporal: true,
  },
  {
    slug: "art_parade",
    display_name: "Art Parade",
    sort_order: 103,
    is_temporal: true,
  },

  // ── Categories targeted by the ingestion pipeline ──
  { slug: "gardens", display_name: "Gardens", sort_order: 110 },
  {
    slug: "botanical_garden",
    display_name: "Botanical Garden",
    parent: "gardens",
  },
  { slug: "arboretum", display_name: "Arboretum", parent: "gardens" },
  { slug: "campground", display_name: "Campground", sort_order: 120 },
  {
    slug: "rv",
    display_name: "RV Park",
    parent: "campground",
  },
  { slug: "tent", display_name: "Tent Camping", parent: "campground" },
  {
    slug: "free_flight",
    display_name: "Free Flight",
    sort_order: 130,
  },
];

export const VALID_CATEGORY_SLUGS = new Set(TAXONOMY.map((category) => category.slug));

export function listCategorySlugs(): string[] {
  return [...VALID_CATEGORY_SLUGS].sort();
}

export function formatCategoryUsageError(prefix: string): string {
  return `${prefix}\nKnown categories: ${listCategorySlugs().join(", ")}`;
}

export function assertValidCategory(slug: string): void {
  if (!VALID_CATEGORY_SLUGS.has(slug)) {
    throw new Error(formatCategoryUsageError(`Unknown category "${slug}" — not in taxonomy.ts.`));
  }
}
