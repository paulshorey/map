import type { Extractor } from "./types.js";
import { bgciExtractor } from "./extractors/bgci.js";
import { wikidataExtractor } from "./extractors/wikidata.js";
import { osmExtractor } from "./extractors/osm.js";
import { arbnetExtractor } from "./extractors/arbnet.js";
import { iabgExtractor } from "./extractors/iabg.js";
import { wikipediaUsExtractor } from "./extractors/wikipedia-us.js";
import { wikipediaIntlExtractor } from "./extractors/wikipedia-intl.js";
import { gardenologyExtractor } from "./extractors/gardenology.js";
import { globalCarnivalistExtractor } from "./extractors/global-carnivalist.js";
import { roughGuidesExtractor } from "./extractors/rough-guides.js";
import type { SourceDefinition } from "./types.js";

const GARDEN_SOURCES: SourceDefinition[] = [
  {
    meta: {
      slug: "bgci",
      name: "BGCI GardenSearch",
      homepage: "https://www.bgci.org/garden_search.php",
      license: "BGCI terms",
      attribution: "BGCI GardenSearch",
      trust: 85,
      coord_trust: 55,
    },
    extractor: bgciExtractor,
    files: [{ pattern: "docs/poi/botanical_gardens_data/bgci_gardens_full.json", category: "botanical_garden" }],
    normalizationProfile: "garden",
  },
  {
    meta: {
      slug: "wikidata",
      name: "Wikidata",
      homepage: "https://www.wikidata.org",
      license: "CC0",
      attribution: "Wikidata",
      trust: 80,
    },
    extractor: wikidataExtractor,
    files: [{ pattern: "docs/poi/botanical_gardens_data/wikidata_botanical_gardens.json", category: "botanical_garden" }],
    normalizationProfile: "garden",
  },
  {
    meta: {
      slug: "osm",
      name: "OpenStreetMap",
      homepage: "https://www.openstreetmap.org",
      license: "ODbL",
      attribution: "© OpenStreetMap contributors",
      trust: 70,
    },
    extractor: osmExtractor,
    files: [{ pattern: "docs/poi/botanical_gardens_data/osm_botanical_gardens.csv", category: "botanical_garden" }],
    normalizationProfile: "garden",
  },
  {
    meta: {
      slug: "arbnet",
      name: "ArbNet Morton Register",
      homepage: "https://arbnet.org",
      attribution: "ArbNet Morton Register",
      trust: 75,
    },
    extractor: arbnetExtractor,
    files: [{ pattern: "docs/poi/botanical_gardens_data/arbnet_morton_register.json", category: "arboretum" }],
    normalizationProfile: "garden",
  },
  {
    meta: {
      slug: "iabg",
      name: "IABG Global Checklist",
      homepage: "http://iabg.scbg.cas.cn",
      attribution: "IABG",
      trust: 70,
    },
    extractor: iabgExtractor,
    files: [{ pattern: "docs/poi/botanical_gardens_data/iabg_checklist_gardens.json", category: "botanical_garden" }],
    normalizationProfile: "garden",
  },
  {
    meta: {
      slug: "wikipedia_us",
      name: "Wikipedia US Gardens",
      homepage: "https://en.wikipedia.org",
      license: "CC-BY-SA",
      attribution: "Wikipedia",
      trust: 60,
    },
    extractor: wikipediaUsExtractor,
    files: [{ pattern: "docs/poi/botanical_gardens_data/wikipedia_us_gardens.json", category: "botanical_garden" }],
    normalizationProfile: "garden",
  },
  {
    meta: {
      slug: "wikipedia_intl",
      name: "Wikipedia International Gardens",
      homepage: "https://en.wikipedia.org",
      license: "CC-BY-SA",
      attribution: "Wikipedia",
      trust: 60,
    },
    extractor: wikipediaIntlExtractor,
    files: [{ pattern: "docs/poi/botanical_gardens_data/wikipedia_intl_gardens.json", category: "botanical_garden" }],
    normalizationProfile: "garden",
  },
  {
    meta: {
      slug: "gardenology",
      name: "Gardenology",
      homepage: "https://gardenology.mywikis.net",
      attribution: "Gardenology",
      trust: 55,
    },
    extractor: gardenologyExtractor,
    files: [{ pattern: "docs/poi/botanical_gardens_data/gardenology_us_gardens.json", category: "botanical_garden" }],
    normalizationProfile: "garden",
  },
];

/** Campground sources — metadata registered; extractors land in a follow-up. */
const CAMPGROUND_SOURCES: SourceDefinition[] = [
  {
    meta: { slug: "ridb", name: "RIDB", trust: 90 },
    files: [{ pattern: "docs/poi/rv_campgrounds_data/ridb/facilities.csv", category: "campground" }],
    normalizationProfile: "campground",
  },
  {
    meta: { slug: "thedyrt", name: "The Dyrt", trust: 50 },
    files: [{ pattern: "docs/poi/rv_campgrounds_data/thedyrt/rv_campgrounds.csv", category: "campground" }],
    normalizationProfile: "campground",
  },
  {
    meta: { slug: "osm_camp", name: "OpenStreetMap Campgrounds", trust: 70 },
    files: [{ pattern: "docs/poi/rv_campgrounds_data/osm/caravan_sites.csv", category: "campground" }],
    normalizationProfile: "campground",
  },
  {
    meta: { slug: "uscampgrounds", name: "US Campgrounds", trust: 55 },
    files: [{ pattern: "docs/poi/rv_campgrounds_data/uscampgrounds/all_campgrounds_combined.csv", category: "campground" }],
    normalizationProfile: "campground",
  },
];

/** Festival sources — metadata registered; extractors land in a follow-up. */
const FESTIVAL_SOURCES: SourceDefinition[] = [
  {
    meta: { slug: "musicbrainz", name: "MusicBrainz", trust: 85 },
    files: [{ pattern: "docs/poi/music-festivals/apis/musicbrainz_festivals_*.json", category: "music_festival" }],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "ticketmaster", name: "Ticketmaster", trust: 75 },
    files: [{ pattern: "docs/poi/music-festivals/apis/ticketmaster_festivals_full.json", category: "music_festival", wrapperPath: "events" }],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "resident_advisor", name: "Resident Advisor", trust: 70 },
    files: [{ pattern: "docs/poi/music-festivals/apis/resident_advisor_festivals.json", category: "music_festival", wrapperPath: "festivals" }],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "musicfestivalwizard", name: "Music Festival Wizard", trust: 65 },
    files: [{ pattern: "docs/poi/music-festivals/directories/musicfestivalwizard_festivals.json", category: "music_festival" }],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "edm_dance_directory", name: "EDM Dance Directory", trust: 45 },
    files: [{ pattern: "docs/poi/music-festivals/apis/edm_dance_directory.json", category: "music_festival" }],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "jambase", name: "JamBase", trust: 75 },
    files: [{ pattern: "docs/poi/music-festivals/apis/jambase_festivals.json", category: "music_festival" }],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "viberate", name: "Viberate", trust: 70 },
    files: [{ pattern: "docs/poi/music-festivals/apis/viberate_festivals.json", category: "music_festival" }],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "songkick", name: "Songkick", trust: 70 },
    files: [
      { pattern: "docs/poi/music-festivals/apis/songkick_festivals.json", category: "music_festival" },
      { pattern: "docs/poi/music-festivals/directories/songkick_browse_festivals.json", category: "music_festival" },
    ],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "festivism", name: "Festivism", trust: 60 },
    files: [{ pattern: "docs/poi/music-festivals/directories/festivism_festivals.json", category: "music_festival" }],
    normalizationProfile: "event",
  },
  {
    meta: { slug: "festivalatlas", name: "Festival Atlas", trust: 60 },
    files: [{ pattern: "docs/poi/music-festivals/directories/festivalatlas_festivals.json", category: "music_festival" }],
    normalizationProfile: "event",
  },
];

/** Carnival sources (docs/poi/carnival/). */
const CARNIVAL_SOURCES: SourceDefinition[] = [
  {
    meta: {
      slug: "global_carnivalist",
      name: "Global Carnivalist",
      homepage: "https://globalcarnivalist.com",
      attribution: "Global Carnivalist",
      trust: 55,
    },
    extractor: globalCarnivalistExtractor,
    files: [{ pattern: "docs/poi/carnival/global_carnivalist.json", category: "carnival" }],
    normalizationProfile: "event",
  },
  {
    meta: {
      slug: "rough_guides",
      name: "Rough Guides Carnivals",
      homepage: "https://www.roughguides.com",
      attribution: "Rough Guides",
      trust: 60,
    },
    extractor: roughGuidesExtractor,
    files: [{ pattern: "docs/poi/carnival/rough_guides_carnivals.json", category: "carnival" }],
    normalizationProfile: "event",
  },
];

const ALL_SOURCES: SourceDefinition[] = [
  ...GARDEN_SOURCES,
  ...CAMPGROUND_SOURCES,
  ...FESTIVAL_SOURCES,
  ...CARNIVAL_SOURCES,
];

const bySlug = new Map(ALL_SOURCES.map((s) => [s.meta.slug, s]));

export function getSourceDefinition(slug: string): SourceDefinition | undefined {
  return bySlug.get(slug);
}

export function getExtractor(slug: string): Extractor | undefined {
  return bySlug.get(slug)?.extractor;
}

export function listSourceSlugs(): string[] {
  return [...bySlug.keys()];
}

export function listSourceDefinitions(): SourceDefinition[] {
  return [...ALL_SOURCES];
}
