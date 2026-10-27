/** Diagnostic provenance for an operational precision value, never venue verification. */
export interface PrecisionEvidence {
  version: string;
  value: string;
  derivation: string;
  provider_class: string | null;
  provider_type: string | null;
  warnings: string[];
}

export const PRECISION_EVIDENCE_VERSION = "geocode-precision-v1";
const text = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export function readPrecisionEvidence(
  value: unknown,
): PrecisionEvidence | null {
  if (!value || typeof value !== "object") return null;
  const p = value as PrecisionEvidence;
  if (
    p.version !== PRECISION_EVIDENCE_VERSION ||
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
  let value = "point",
    derivation = "fallback";
  if (type === "country" || type === "state") {
    value = "region";
    derivation = "provider_type";
  } else if (
    [
      "city",
      "town",
      "village",
      "administrative",
      "county",
      "suburb",
      "municipality",
    ].includes(type)
  ) {
    value = "city";
    derivation = "provider_type";
  } else if (cls === "boundary") {
    value = "region";
    derivation = "provider_class";
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
