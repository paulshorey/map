export function str(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

export function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
}

/** Strip Wikipedia citation markers like "[ 4 ]" from names. */
export function cleanName(name: string): string {
  return name.replace(/\s*\[\s*\d+\s*\]\s*/g, " ").replace(/\s+/g, " ").trim();
}

export function countryNameToCode(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const map: Record<string, string> = {
    "united states": "US",
    "united states of america": "US",
    usa: "US",
    "united kingdom": "GB",
    uk: "GB",
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
  };
  return map[country.toLowerCase().trim()];
}
