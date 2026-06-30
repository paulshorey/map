/**
 * Code-owned POI category taxonomy (overview Decision 5).
 *
 * This is the single source of truth for categories, their hierarchy, which ones are
 * temporal (events), and the raw-string aliases used during ingestion normalization.
 * Edit here, then run `pnpm --filter @lib/db-map ingest:taxonomy:seed` to project it into
 * `canonical_categories` + `research_category_aliases`.
 */

export interface CategorySeed {
  slug: string;
  display_name: string;
  parent?: string;
  sort_order?: number;
  is_temporal?: boolean;
  aliases?: string[];
}

export const TAXONOMY: CategorySeed[] = [
  // ── General places (used by the current example/seed data) ──
  { slug: "park", display_name: "Park", sort_order: 10, aliases: ["park"] },
  { slug: "historic_site", display_name: "Historic Site", sort_order: 20, aliases: ["historic site", "monument"] },
  { slug: "museum", display_name: "Museum", sort_order: 30, aliases: ["museum"] },
  { slug: "viewpoint", display_name: "Viewpoint", sort_order: 40, aliases: ["viewpoint", "lookout"] },
  { slug: "restaurant", display_name: "Restaurant", sort_order: 50, aliases: ["restaurant"] },
  { slug: "shop", display_name: "Shop", sort_order: 60, aliases: ["shop", "market"] },
  { slug: "cafe", display_name: "Cafe", sort_order: 70, aliases: ["cafe", "café", "coffee"] },
  { slug: "beach", display_name: "Beach", sort_order: 80, aliases: ["beach"] },
  { slug: "trail", display_name: "Trail", sort_order: 90, aliases: ["trail", "hike"] },

  // ── Events (temporal) ──
  {
    slug: "music_festival",
    display_name: "Music Festival",
    sort_order: 100,
    is_temporal: true,
    aliases: ["music festival", "festival"],
  },

  // ── Categories targeted by the ingestion pipeline ──
  { slug: "gardens", display_name: "Gardens", sort_order: 110 },
  {
    slug: "botanical_garden",
    display_name: "Botanical Garden",
    parent: "gardens",
    aliases: ["botanical garden", "garden:type=botanical", "jardin botanique"],
  },
  { slug: "arboretum", display_name: "Arboretum", parent: "gardens", aliases: ["arboretum", "arboreta"] },
  { slug: "campground", display_name: "Campground", sort_order: 120 },
  {
    slug: "rv",
    display_name: "RV Park",
    parent: "campground",
    aliases: ["rv", "caravan", "caravan_site", "tourism=caravan_site", "motorhome", "rv_hookup"],
  },
  { slug: "tent", display_name: "Tent Camping", parent: "campground", aliases: ["tent", "tent_only"] },
  {
    slug: "free_flight",
    display_name: "Free Flight",
    sort_order: 130,
    aliases: ["flying site", "paragliding", "hang gliding", "gliderport"],
  },
];
