import {
  evidenceValue,
  formatEvidencePath,
  parseEvidencePath,
} from "./attributes.js";
import type { ResolvedNormalization } from "./resolve.js";
import type { NormalizationEvidence } from "./contracts.js";

const numericSurveyKeys = [
  "total_area_hectares",
  "visitors_annual",
  "staff_total",
];
const surveyKeys = new Set([
  ...numericSurveyKeys,
  "policy_exists",
  "organisation_type",
  "education_resources",
]);
const classificationFields = new Set([
  "is_poi",
  "invalid_reason",
  "entity_kind",
]);
export const BGCI_REPAIR_INSTRUCTIONS =
  "For evidence, cite exact paths under raw, captured or deterministic. " +
  "For is_poi, invalid_reason and entity_kind you may also cite ingest_category or an element of allowed_category_slugs as classification context. " +
  "Base visitability on source evidence. A routing category or policy topic alone does not establish public access.";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep original evidence paths and question wording, including units, on the one allowed repair. */
export function bgciRepairPacket(packet: Record<string, unknown>) {
  const raw = packet.raw;
  if (!isObject(raw) || !isObject(raw.attributes)) return null;
  const entries = Object.entries(raw.attributes);
  const selected = entries.filter(([key]) => surveyKeys.has(key));
  if (selected.length === entries.length) return null;
  const compact: Record<string, unknown> = {
    ...packet,
    repair_context_version: "bgci-survey-repair-v2",
    raw: { ...raw, attributes: Object.fromEntries(selected) },
  };
  if (isObject(packet.deterministic)) {
    const facts = { ...packet.deterministic };
    // Keep IDs and array positions stable so citations resolve in both packets.
    for (const key of [
      "coordinateCandidates",
      "urlCandidates",
      "phoneCandidates",
      "emailCandidates",
    ]) {
      const candidates = facts[key];
      if (Array.isArray(candidates)) {
        facts[key] = candidates.map((candidate) => {
          if (!isObject(candidate) || typeof candidate.path !== "string")
            return candidate;
          if (
            evidenceValue(compact, candidate.path, { enumerableOnly: true }) !==
            undefined
          )
            return candidate;
          const { path, ...visibleCandidate } = candidate;
          return visibleCandidate;
        });
      }
    }
    compact.deterministic = facts;
  }
  return compact;
}

export function normalizeRepairEvidence(
  packet: Record<string, unknown>,
  evidence: NormalizationEvidence[],
): NormalizationEvidence[] {
  return evidence.map(({ field, paths }) => ({
    field,
    paths: paths.map((path) => {
      const segments = parseEvidencePath(path);
      const root = segments?.[0];
      const sourcePath =
        segments &&
        segments.length >= 2 &&
        (root === "raw" || root === "captured" || root === "deterministic");
      const categoryPath =
        classificationFields.has(field) &&
        segments &&
        ((root === "ingest_category" && segments.length === 1) ||
          (root === "allowed_category_slugs" && segments.length === 2));
      if (
        !segments ||
        (!sourcePath && !categoryPath) ||
        // JSON exposes array elements, but not JavaScript properties like length.
        evidenceValue(packet, segments, { enumerableOnly: true }) === undefined
      )
        throw new Error(
          `BGCI repair has an unresolved evidence path for ${field}: ${path}`,
        );
      return formatEvidencePath(segments);
    }),
  }));
}

/** Preserve selected scalar survey answers even when the model summarizes or omits them. */
export function restoreBgciSurveyFacts(
  raw: unknown,
  capturedAttributes: Record<string, unknown>,
  resolved: Pick<
    ResolvedNormalization,
    "attributes" | "fieldEvidence" | "warnings"
  >,
) {
  if (!isObject(raw) || !isObject(raw.attributes)) return;
  const survey = raw.attributes;
  function restore(key: string, value: number | string, path: string) {
    if (Object.hasOwn(capturedAttributes, key)) return;
    if (
      Object.hasOwn(resolved.attributes, key) &&
      resolved.attributes[key] !== value
    )
      resolved.warnings.push(`attribute_source_conflict_${key}`);
    resolved.attributes[key] = value;
    resolved.fieldEvidence[`attributes.${key}`] = [path];
  }
  for (const key of numericSurveyKeys) {
    const entry = survey[key];
    if (!isObject(entry)) continue;
    const value = entry.value;
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      value >= 0 &&
      (key === "total_area_hectares" || Number.isSafeInteger(value))
    )
      restore(key, value, `$.raw.attributes.${key}.value`);
  }
  const policies = survey.policy_exists;
  if (isObject(policies) && Array.isArray(policies.value)) {
    const index = policies.value.indexOf("Accessibility");
    if (index >= 0)
      restore(
        "accessibility_policy_topic",
        "Accessibility",
        `$.raw.attributes.policy_exists.value[${index}]`,
      );
  }
}
