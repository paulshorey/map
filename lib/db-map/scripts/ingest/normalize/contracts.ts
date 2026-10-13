export const NORMALIZER_VERSION = "hybrid-v4";
export const PROMPT_VERSION = "poi-normalize-v3";
export const SCHEMA_VERSION = "poi-normalize-schema-v1";
export const EXAMPLES_VERSION = "poi-normalize-examples-v1";

export interface NormalizationEvidence {
  field: string;
  paths: string[];
}

export interface NormalizedAttribute {
  key: string;
  value: string | number | boolean;
}

export interface LlmNormalizationRecord {
  record_id: string;
  is_poi: boolean;
  invalid_reason: string | null;
  entity_kind:
    | "place"
    | "event_series"
    | "event_occurrence"
    | "contained_feature"
    | "organization"
    | "article"
    | "region"
    | "tour"
    | "listing"
    | "other";
  display_name: string | null;
  series_name: string | null;
  edition_year: number | null;
  aliases: string[];
  description: string | null;
  venue: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  website_candidate_id: string | null;
  phone_candidate_id: string | null;
  email_candidate_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  date_precision: "day" | "month" | "year" | null;
  attributes: NormalizedAttribute[];
  warnings: string[];
  evidence: NormalizationEvidence[];
}

export interface LlmNormalizationOutput {
  record: LlmNormalizationRecord;
}

const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
const nullableInteger = { anyOf: [{ type: "integer" }, { type: "null" }] };
const entityKinds = [
  "place",
  "event_series",
  "event_occurrence",
  "contained_feature",
  "organization",
  "article",
  "region",
  "tour",
  "listing",
  "other",
];

export const NORMALIZATION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["record"],
  properties: {
    record: {
      type: "object",
      additionalProperties: false,
      required: [
        "record_id",
        "is_poi",
        "invalid_reason",
        "entity_kind",
        "display_name",
        "series_name",
        "edition_year",
        "aliases",
        "description",
        "venue",
        "address",
        "city",
        "region",
        "country_code",
        "website_candidate_id",
        "phone_candidate_id",
        "email_candidate_id",
        "starts_at",
        "ends_at",
        "date_precision",
        "attributes",
        "warnings",
        "evidence",
      ],
      properties: {
        record_id: { type: "string" },
        is_poi: { type: "boolean" },
        invalid_reason: nullableString,
        entity_kind: {
          type: "string",
          enum: entityKinds,
        },
        display_name: nullableString,
        series_name: nullableString,
        edition_year: nullableInteger,
        aliases: { type: "array", items: { type: "string" } },
        description: nullableString,
        venue: nullableString,
        address: nullableString,
        city: nullableString,
        region: nullableString,
        country_code: nullableString,
        website_candidate_id: nullableString,
        phone_candidate_id: nullableString,
        email_candidate_id: nullableString,
        starts_at: nullableString,
        ends_at: nullableString,
        date_precision: {
          anyOf: [
            { type: "string", enum: ["day", "month", "year"] },
            { type: "null" },
          ],
        },
        attributes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "value"],
            properties: {
              key: { type: "string" },
              value: {
                anyOf: [
                  { type: "string" },
                  { type: "number" },
                  { type: "boolean" },
                ],
              },
            },
          },
        },
        warnings: { type: "array", items: { type: "string" } },
        evidence: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field", "paths"],
            properties: {
              field: { type: "string" },
              paths: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
  },
};

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseNormalizationOutput(
  value: unknown,
  expectedId: string,
): LlmNormalizationOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Normalization output must be an object");
  }
  const record = (value as { record?: unknown }).record;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("Normalization output missing record object");
  }
  const r = record as Record<string, unknown>;
  if (r.record_id !== expectedId)
    throw new Error("Normalization record_id mismatch");
  if (typeof r.is_poi !== "boolean")
    throw new Error("Normalization is_poi must be boolean");
  for (const key of [
    "invalid_reason",
    "display_name",
    "series_name",
    "description",
    "venue",
    "address",
    "city",
    "region",
    "country_code",
    "website_candidate_id",
    "phone_candidate_id",
    "email_candidate_id",
    "starts_at",
    "ends_at",
  ]) {
    if (!isNullableString(r[key]))
      throw new Error(`Normalization ${key} must be string or null`);
  }
  if (
    !Array.isArray(r.aliases) ||
    !r.aliases.every((v) => typeof v === "string")
  ) {
    throw new Error("Normalization aliases must be strings");
  }
  if (
    !Array.isArray(r.attributes) ||
    !Array.isArray(r.warnings) ||
    !Array.isArray(r.evidence)
  ) {
    throw new Error(
      "Normalization attributes/warnings/evidence must be arrays",
    );
  }
  if (!entityKinds.includes(r.entity_kind as string))
    throw new Error("Normalization entity_kind is invalid");
  if (r.edition_year !== null && !Number.isSafeInteger(r.edition_year))
    throw new Error("Normalization edition_year must be an integer or null");
  if (
    r.date_precision !== null &&
    !["day", "month", "year"].includes(r.date_precision as string)
  )
    throw new Error("Normalization date_precision is invalid");
  if (!r.warnings.every((v) => typeof v === "string"))
    throw new Error("Normalization warnings must be strings");
  if (
    !r.attributes.every(
      (v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof v.key === "string" &&
        v.key.trim().length > 0 &&
        (typeof v.value === "string" ||
          typeof v.value === "boolean" ||
          (typeof v.value === "number" && Number.isFinite(v.value))),
    )
  )
    throw new Error(
      "Normalization attributes must contain keys and finite primitive values",
    );
  if (
    !r.evidence.every(
      (v) =>
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        typeof v.field === "string" &&
        Array.isArray(v.paths) &&
        v.paths.every((path: unknown) => typeof path === "string"),
    )
  )
    throw new Error(
      "Normalization evidence must contain fields and string paths",
    );
  return value as LlmNormalizationOutput;
}
