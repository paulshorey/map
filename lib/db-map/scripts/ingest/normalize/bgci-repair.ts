import { evidenceValue } from "./attributes.js";
import type { ResolvedNormalization } from "./resolve.js";
import type { NormalizationEvidence } from "./contracts.js";

const numericSurveyKeys = [
  "total_area_hectares",
  "visitors_annual",
  "staff_total",
];
const surveyKeys = new Set([...numericSurveyKeys, "policy_exists"]);

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
  return {
    ...packet,
    repair_context_version: "bgci-survey-repair-v1",
    raw: { ...raw, attributes: Object.fromEntries(selected) },
  };
}

export function validateRepairEvidence(
  packet: Record<string, unknown>,
  evidence: NormalizationEvidence[],
) {
  for (const { field, paths } of evidence) {
    for (const path of paths) {
      if (
        !/^\$\.(?:raw|captured|deterministic)(?:\.|\[)/.test(path) ||
        evidenceValue(packet, path) == null
      )
        throw new Error(
          `BGCI repair has an unresolved evidence path for ${field}: ${path}`,
        );
    }
  }
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
