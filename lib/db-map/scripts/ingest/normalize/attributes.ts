import type { NormalizedAttribute } from "./contracts.js";
import type { DeterministicInput } from "./deterministic.js";

type AttributeValue = string | number | boolean;
const numericKeys = new Set([
  "rating",
  "reviews_count",
  "price_low",
  "price_high",
  "max_vehicle_length_ft",
  "num_sites",
]);
const booleanKeys = new Set([
  "wifi",
  "showers",
  "reservable",
  "pets_allowed",
  "sanitary_dump",
  "sewer_hookups",
  "water_hookups",
  "electric_hookups",
  "accommodation_rv",
  "accommodation_tent",
  "thirty_amp",
  "fifty_amp",
  "big_rig_friendly",
  "pull_through",
  "back_in",
]);

function primitive(value: unknown): value is AttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function safeKey(key: string): boolean {
  return (
    Boolean(key.trim()) &&
    !["__proto__", "constructor", "prototype"].includes(key)
  );
}

/** Coerce only known typed attributes; opaque IDs, ZIP codes and text stay intact. */
export function normalizeAttributeValue(
  key: string,
  value: AttributeValue,
): AttributeValue {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (numericKeys.has(key) && /^-?\d+(?:\.\d+)?$/.test(text)) {
    const number = Number(text);
    if (
      Number.isFinite(number) &&
      (!["reviews_count", "num_sites"].includes(key) || Number.isSafeInteger(number))
    )
      return number;
  }
  if (booleanKeys.has(key) && /^(true|false)$/i.test(text))
    return text.toLowerCase() === "true";
  return value;
}

function pathForKey(prefix: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${prefix}.${key}`
    : `${prefix}[${JSON.stringify(key)}]`;
}

/** Read a simple JSON path without eval, wildcards, inherited properties or container matches. */
function evidenceValue(input: unknown, path: string): unknown {
  if (!path.startsWith("$")) return undefined;
  const segments =
    path
      .slice(1)
      .match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\]/g) ?? [];
  if (segments.join("") !== path.slice(1)) return undefined;
  let value = input;
  for (const segment of segments) {
    let key: string | number;
    try {
      key = segment.startsWith(".")
        ? segment.slice(1)
        : JSON.parse(segment.slice(1, -1));
    } catch {
      return undefined;
    }
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

export function resolveAttributes(
  captured: DeterministicInput,
  proposed: NormalizedAttribute[],
  evidence: Record<string, string[]>,
  warnings: string[],
): Record<string, AttributeValue> {
  const result: Record<string, AttributeValue> = {};
  const sourcePaths: Record<string, string> = {};
  for (const [key, value] of Object.entries(captured.attributes)) {
    if (!safeKey(key) || !primitive(value)) continue;
    result[key] = normalizeAttributeValue(key, value);
    sourcePaths[key] = pathForKey("$.captured.attributes", key);
  }
  const modelKeys = new Set<string>();
  const conflictingKeys = new Set<string>();
  const proposedEvidence = { ...evidence };
  for (const { key, value } of proposed) {
    if (!safeKey(key) || !primitive(value)) {
      warnings.push("attribute_dropped_key_or_value");
      continue;
    }
    modelKeys.add(key);
    if (conflictingKeys.has(key)) continue;
    const normalized = normalizeAttributeValue(key, value);
    if (Object.hasOwn(sourcePaths, key)) {
      if (normalized !== result[key])
        warnings.push(`attribute_source_conflict_${key}`);
      continue;
    }
    const paths = [
      ...new Set([
        ...(proposedEvidence[`attributes.${key}`] ?? []),
        ...(proposedEvidence[key] ?? []),
      ]),
    ].filter((path) => {
      const sourceValue = evidenceValue({ captured, raw: captured.raw }, path);
      return (
        primitive(sourceValue) &&
        normalizeAttributeValue(key, sourceValue) === normalized
      );
    });
    if (!paths.length) {
      warnings.push(`attribute_dropped_${key}`);
      continue;
    }
    // Repeated contradictory proposals cannot silently replace a validated value.
    if (Object.hasOwn(result, key) && result[key] !== normalized) {
      warnings.push(`attribute_conflicting_proposals_${key}`);
      conflictingKeys.add(key);
      delete result[key];
      delete evidence[`attributes.${key}`];
      continue;
    }
    result[key] = normalized;
    evidence[`attributes.${key}`] = paths;
  }
  for (const [key, path] of Object.entries(sourcePaths))
    evidence[`attributes.${key}`] = [path];
  if (Object.keys(sourcePaths).some((key) => !modelKeys.has(key)))
    warnings.push("captured_attributes_restored");
  return result;
}
