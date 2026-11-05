export interface NormalizationProfile {
  id: string;
  version: string;
  kind: "event" | "place";
  listingDomains: string[];
  /** A website identical to the record's own source_url is its listing page, never official. */
  selfListingNotOfficial: boolean;
  hardFalsePaths: string[];
  descriptionLimit: number;
}

const PROFILES: Record<string, NormalizationProfile> = {
  event: {
    id: "event",
    // v2: self-listing websites (Biennial Foundation lists its own page) are not official.
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
    ],
    selfListingNotOfficial: true,
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
    selfListingNotOfficial: false,
    hardFalsePaths: [],
    descriptionLimit: 3000,
  },
  campground: {
    id: "campground",
    version: "campground-v1",
    kind: "place",
    listingDomains: ["thedyrt.com", "recreation.gov"],
    selfListingNotOfficial: false,
    hardFalsePaths: [],
    descriptionLimit: 3000,
  },
  place: {
    id: "place",
    version: "place-v1",
    kind: "place",
    listingDomains: [],
    selfListingNotOfficial: false,
    hardFalsePaths: [],
    descriptionLimit: 3000,
  },
};

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
