/** Diagnostic provenance for an operational precision value, never venue verification. */
export interface PrecisionEvidence {
  version: string;
  value: string;
  derivation: string;
  provider_class: string | null;
  provider_type: string | null;
  warnings: string[];
}

// v2 classifies country-level results as `country` (v1 called them region/city).
// v3 reads an administrative boundary's precision from its finest address field
// ("England" is a state, not a city) and treats islands, counties and similar areas as regions.
// v4: a row without class/type takes its precision from its address fields; it was a point.
export const PRECISION_EVIDENCE_VERSION = "geocode-precision-v4";
const READABLE_VERSIONS = new Set([
  "geocode-precision-v1",
  "geocode-precision-v2",
  "geocode-precision-v3",
  "geocode-precision-v4",
]);
// Address fields finer than a city: their presence means the row names a specific place.
const POINT_ADDRESS_KEYS = [
  "house_number",
  "road",
  "name",
  "building",
  "amenity",
  "shop",
  "tourism",
  "leisure",
  "neighbourhood",
  "quarter",
  "office",
  "historic",
];
const CITY_ADDRESS_KEYS = [
  "city",
  "town",
  "village",
  "hamlet",
  "municipality",
  "suburb",
  "city_district",
];
const REGION_ADDRESS_KEYS = [
  "state",
  "region",
  "province",
  "state_district",
  "county",
  "island",
  "archipelago",
];
const text = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export function readPrecisionEvidence(
  value: unknown,
): PrecisionEvidence | null {
  if (!value || typeof value !== "object") return null;
  const p = value as PrecisionEvidence;
  if (
    !READABLE_VERSIONS.has(p.version) ||
    typeof p.value !== "string" ||
    typeof p.derivation !== "string" ||
    !Array.isArray(p.warnings) ||
    !p.warnings.every((w) => typeof w === "string")
  )
    return null;
  return {
    version: p.version,
    value: p.value,
    derivation: p.derivation,
    provider_class: text(p.provider_class),
    provider_type: text(p.provider_type),
    warnings: [...p.warnings],
  };
}

/** Preserve the existing classifier, making its point fallback explicit. */
export function deriveForwardPrecision(
  row: Record<string, unknown>,
): PrecisionEvidence {
  const type = typeof row.type === "string" ? row.type.toLowerCase() : "";
  const cls = typeof row.class === "string" ? row.class.toLowerCase() : "";
  const address =
    row.address && typeof row.address === "object"
      ? Object.keys(row.address)
      : [];
  let value = "point",
    derivation = "fallback";
  if (type === "country" || row.addresstype === "country") {
    value = "country";
    derivation = "provider_type";
  } else if (
    address.length > 0 &&
    address.every((key) => key === "country" || key === "country_code")
  ) {
    // A country boundary arrives as administrative/boundary with only country fields.
    value = "country";
    derivation = "provider_address";
  } else if (
    [
      "state",
      "region",
      "province",
      "state_district",
      "county",
      "island",
      "archipelago",
    ].includes(type)
  ) {
    value = "region";
    derivation = "provider_type";
  } else if (
    ["city", "town", "village", "hamlet", "suburb", "municipality", "postcode"].includes(
      type,
    ) ||
    row.addresstype === "postcode"
  ) {
    // A postal area is about city-sized.
    value = "city";
    derivation = "provider_type";
  } else if (
    (type === "administrative" || cls === "boundary") &&
    address.length > 0
  ) {
    // A boundary is as specific as the finest place its own address names.
    value = address.some((key) => CITY_ADDRESS_KEYS.includes(key))
      ? "city"
      : address.some((key) => REGION_ADDRESS_KEYS.includes(key))
        ? "region"
        : "country";
    derivation = "provider_address";
  } else if (type === "administrative") {
    value = "city";
    derivation = "provider_type";
  } else if (cls === "boundary") {
    value = "region";
    derivation = "provider_class";
  } else if (
    !cls &&
    !type &&
    address.length > 0 &&
    !address.some((key) => POINT_ADDRESS_KEYS.includes(key))
  ) {
    // No granularity fields: "Zongolica, Veracruz, Mexico" names a town, not a point.
    // A postal area is about city-sized, never a whole country.
    value = address.some((key) => CITY_ADDRESS_KEYS.includes(key) || key === "postcode")
      ? "city"
      : address.some((key) => REGION_ADDRESS_KEYS.includes(key))
        ? "region"
        : "country";
    derivation = "provider_address";
  }
  const provider_class = text(row.class),
    provider_type = text(row.type);
  return {
    version: PRECISION_EVIDENCE_VERSION,
    value,
    derivation,
    provider_class,
    provider_type,
    warnings: [
      ...(derivation === "fallback" ? ["point_precision_default"] : []),
      ...(!provider_class && !provider_type
        ? ["provider_granularity_missing"]
        : []),
    ],
  };
}

/** Old parsed cache/artifact data cannot establish which classifier produced its precision. */
export function storedPrecisionEvidence(
  hit: {
    precision?: unknown;
    precision_evidence?: unknown;
    provider_class?: unknown;
    provider_type?: unknown;
  },
  origin: "legacy_cache" | "legacy_artifact",
): PrecisionEvidence {
  const recorded = readPrecisionEvidence(hit.precision_evidence);
  const value = typeof hit.precision === "string" ? hit.precision : "unknown";
  if (recorded?.value === value) return recorded;
  const provider_class = text(hit.provider_class),
    provider_type = text(hit.provider_type);
  return {
    version: PRECISION_EVIDENCE_VERSION,
    value,
    derivation: origin,
    provider_class,
    provider_type,
    warnings: [
      "precision_derivation_not_recorded",
      ...(!provider_class && !provider_type
        ? ["provider_granularity_missing"]
        : []),
    ],
  };
}
