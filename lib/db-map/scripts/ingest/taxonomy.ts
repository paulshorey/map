/**
 * Code-owned POI category taxonomy (overview Decision 5).
 *
 * This is the single source of truth for canonical categories, their hierarchy, and
 * which ones are temporal (events). Ingestion is strict: the developer passes one or more
 * canonical slugs via `--category` (repeat the flag; the first is the primary category),
 * and unknown slugs fail before anything is written.
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
  { slug: "fine_art", display_name: "Fine Art Fair", parent: "art_fair", is_temporal: true },
  { slug: "craft_fair", display_name: "Craft Fair", parent: "art_fair", is_temporal: true },
  {
    slug: "renaissance_fair",
    display_name: "Renaissance Fair",
    parent: "art_fair",
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
  { slug: "hang_gliding", display_name: "Hang Gliding", parent: "free_flight" },
  { slug: "paragliding", display_name: "Paragliding", parent: "free_flight" },
  { slug: "sailplane", display_name: "Sailplane", parent: "free_flight" },
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

const CATEGORY_BY_SLUG = new Map(TAXONOMY.map((category) => [category.slug, category]));

/** True when the category (or any ancestor) is temporal (an event). */
export function isTemporalCategory(slug: string): boolean {
  let current = CATEGORY_BY_SLUG.get(slug);
  const seen = new Set<string>();
  while (current && !seen.has(current.slug)) {
    if (current.is_temporal) return true;
    seen.add(current.slug);
    current = current.parent ? CATEGORY_BY_SLUG.get(current.parent) : undefined;
  }
  return false;
}

function hasAncestor(slug: string, ancestorSlug: string): boolean {
  let current = CATEGORY_BY_SLUG.get(slug);
  const seen = new Set<string>();
  while (current && !seen.has(current.slug)) {
    if (current.slug === ancestorSlug) return true;
    seen.add(current.slug);
    current = current.parent ? CATEGORY_BY_SLUG.get(current.parent) : undefined;
  }
  return false;
}

/**
 * Map a canonical category slug to a normalization profile id. Driven by the taxonomy:
 * temporal categories (and their children) use the event profile; the campground and
 * gardens families use their dedicated profiles; everything else falls back to place.
 * Selection uses the primary (first) declared category on multi-category imports.
 */
export function normalizationProfileForCategory(slug: string): string {
  if (isTemporalCategory(slug)) return "event";
  if (hasAncestor(slug, "campground")) return "campground";
  if (hasAncestor(slug, "gardens")) return "garden";
  return "place";
}
