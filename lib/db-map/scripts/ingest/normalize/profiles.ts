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
    version: "event-v1",
    kind: "event",
    listingDomains: [
      "ra.co",
      "residentadvisor.net",
      "musicfestivalwizard.com",
      "ticketmaster.com",
      "eventbrite.com",
      "artsy.net",
      "festivism.com",
    ],
    hardFalsePaths: ["$.raw.is_festival"],
    descriptionLimit: 3000,
  },
  garden: {
    id: "garden",
    version: "garden-v1",
    kind: "place",
    listingDomains: ["bgci.org", "arbnet.org", "wikidata.org", "wikipedia.org", "openstreetmap.org"],
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

export function getNormalizationProfile(id: string | undefined): NormalizationProfile {
  return PROFILES[id ?? "place"] ?? PROFILES.place!;
}

export function isListingDomain(domain: string | null, profile: NormalizationProfile): boolean {
  if (!domain) return false;
  return profile.listingDomains.some((listed) => domain === listed || domain.endsWith(`.${listed}`));
}
