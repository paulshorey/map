import countries from "i18n-iso-countries";

/** ISO country values only. Ambiguous region names are not country evidence. */
const aliases: Record<string, string> = {
  uk: "GB",
  "u.s.a.": "US",
  "u.s.": "US",
  "great britain": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "south korea": "KR",
  "north korea": "KP",
  russia: "RU",
  turkey: "TR",
  "ivory coast": "CI",
  "cote d'ivoire": "CI",
  "cape verde": "CV",
  "east timor": "TL",
  laos: "LA",
  vietnam: "VN",
  drc: "CD",
  "democratic republic of congo": "CD",
  "democratic republic of the congo": "CD",
};
export function countryToCode(
  value: string | null | undefined,
): string | undefined {
  const key = value?.trim().normalize("NFKC");
  if (!key) return undefined;
  const upper = key.toUpperCase();
  if (Object.hasOwn(countries.getAlpha2Codes(), upper)) return upper;
  return (
    aliases[key.toLowerCase()] ??
    countries.alpha3ToAlpha2(upper) ??
    countries.numericToAlpha2(upper) ??
    countries.getAlpha2Code(key, "en")
  );
}
