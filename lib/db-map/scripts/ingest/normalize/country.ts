/**
 * Country-value normalization (M5, overview §15.3). Sources often put a
 * sub-national region (state/province) where a country belongs. Resolve those
 * to an ISO-2 country code, and normalize full country names too.
 */

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "u.s.a.": "US",
  america: "US",
  "united kingdom": "GB",
  "great britain": "GB",
  uk: "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  canada: "CA",
  australia: "AU",
  mexico: "MX",
  france: "FR",
  germany: "DE",
  italy: "IT",
  spain: "ES",
  japan: "JP",
  china: "CN",
  india: "IN",
  brazil: "BR",
  netherlands: "NL",
  belgium: "BE",
  switzerland: "CH",
  austria: "AT",
  poland: "PL",
  "czech republic": "CZ",
  czechia: "CZ",
  portugal: "PT",
  ireland: "IE",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  "new zealand": "NZ",
  "south africa": "ZA",
  argentina: "AR",
  chile: "CL",
  "south korea": "KR",
  "republic of korea": "KR",
  russia: "RU",
  turkey: "TR",
  greece: "GR",
  hungary: "HU",
  romania: "RO",
  gibraltar: "GB",
};

/** Common sub-national regions → country code (extend as data demands). */
const SUBNATIONAL_TO_CODE: Record<string, string> = {
  // Germany
  bavaria: "DE",
  bayern: "DE",
  "north rhine-westphalia": "DE",
  saxony: "DE",
  hesse: "DE",
  // UK
  "greater london": "GB",
  london: "GB",
  // Spain
  catalonia: "ES",
  catalunya: "ES",
  andalusia: "ES",
  // Canada
  ontario: "CA",
  quebec: "CA",
  "british columbia": "CA",
  alberta: "CA",
};

export function countryToCode(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const key = value.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(key)) return key.toUpperCase();
  return COUNTRY_NAME_TO_CODE[key] ?? SUBNATIONAL_TO_CODE[key];
}
