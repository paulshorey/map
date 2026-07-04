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
    },
    extractor: bgciExtractor,
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
  },
];

/** Campground sources — metadata registered; extractors land in a follow-up. */
const CAMPGROUND_SOURCES: SourceDefinition[] = [
  { meta: { slug: "ridb", name: "RIDB", trust: 90 } },
  { meta: { slug: "thedyrt", name: "The Dyrt", trust: 50 } },
  { meta: { slug: "osm_camp", name: "OpenStreetMap Campgrounds", trust: 70 } },
  { meta: { slug: "uscampgrounds", name: "US Campgrounds", trust: 55 } },
];

/** Festival sources — metadata registered; extractors land in a follow-up. */
const FESTIVAL_SOURCES: SourceDefinition[] = [
  { meta: { slug: "musicbrainz", name: "MusicBrainz", trust: 85 } },
  { meta: { slug: "ticketmaster", name: "Ticketmaster", trust: 75 } },
  { meta: { slug: "resident_advisor", name: "Resident Advisor", trust: 70 } },
  { meta: { slug: "musicfestivalwizard", name: "Music Festival Wizard", trust: 65 } },
  { meta: { slug: "edm_dance_directory", name: "EDM Dance Directory", trust: 45 } },
  { meta: { slug: "jambase", name: "JamBase", trust: 75 } },
  { meta: { slug: "viberate", name: "Viberate", trust: 70 } },
  { meta: { slug: "songkick", name: "Songkick", trust: 70 } },
  { meta: { slug: "festivism", name: "Festivism", trust: 60 } },
  { meta: { slug: "festivalatlas", name: "Festival Atlas", trust: 60 } },
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
