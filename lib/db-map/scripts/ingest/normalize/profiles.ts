export interface NormalizationProfile {
  id: string;
  version: string;
  kind: "event" | "place";
  listingDomains: string[];
  hardFalsePaths: string[];
  descriptionLimit: number;
}

const PROFILES: Record<string, NormalizationProfile> = {
  event: {
    id: "event",
    // v2: biennialfoundation.org is a directory; its listing pages are never official sites.
    version: "event-v2",
    kind: "event",
    listingDomains: [
      "jambase.com",
      "thatfestivalsite.com",
      "ra.co",
      "residentadvisor.net",
      "musicfestivalwizard.com",
      "ticketmaster.com",
      "eventbrite.com",
      "artsy.net",
      "festivism.com",
      "biennialfoundation.org",
    ],
    hardFalsePaths: ["$.raw.is_festival"],
    descriptionLimit: 3000,
  },
  garden: {
    id: "garden",
    version: "garden-v1",
    kind: "place",
    listingDomains: [
      "bgci.org",
      "arbnet.org",
      "wikidata.org",
      "wikipedia.org",
      "openstreetmap.org",
    ],
    hardFalsePaths: [],
    descriptionLimit: 3000,
  },
  campground: {
    id: "campground",
    version: "campground-v1",
    kind: "place",
    listingDomains: ["thedyrt.com", "recreation.gov"],
    hardFalsePaths: [],
    descriptionLimit: 3000,
  },
  place: {
    id: "place",
    version: "place-v1",
    kind: "place",
    listingDomains: [],
    hardFalsePaths: [],
    descriptionLimit: 3000,
  },
};

/** Every current profile version (used to detect normalizations from older profiles). */
export function allNormalizationProfileVersions(): string[] {
  return Object.values(PROFILES).map((profile) => profile.version);
}

export function getNormalizationProfile(
  id: string | undefined,
): NormalizationProfile {
  return PROFILES[id ?? "place"] ?? PROFILES.place!;
}

export function isListingDomain(
  domain: string | null,
  profile: NormalizationProfile,
): boolean {
  if (!domain) return false;
  return profile.listingDomains.some(
    (listed) => domain === listed || domain.endsWith(`.${listed}`),
  );
}
