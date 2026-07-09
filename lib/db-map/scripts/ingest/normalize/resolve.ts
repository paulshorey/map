import { stableHash } from "../hash.js";
import { normalizeName, websiteDomain } from "./text.js";
import { strictDate, type DeterministicFacts, type DeterministicInput } from "./deterministic.js";
import type { LlmNormalizationOutput } from "./contracts.js";
import { isListingDomain, type NormalizationProfile } from "./profiles.js";

export interface ResolvedNormalization {
  status: "accepted" | "rejected" | "degraded";
  isPoi: boolean;
  invalidReason: string | null;
  entityKind: string | null;
  displayName: string | null;
  matchName: string | null;
  editionYear: number | null;
  aliases: string[];
  description: string | null;
  website: string | null;
  websiteDomain: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  venue: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  categorySlugs: string[];
  startsAt: string | null;
  endsAt: string | null;
  datePrecision: "day" | "month" | "year" | null;
  attributes: Record<string, string | number | boolean>;
  fieldEvidence: Record<string, string[]>;
  warnings: string[];
  matchFingerprint: string;
}

function candidateById<T extends { id: string }>(items: T[], id: string | null): T | null {
  if (!id) return null;
  return items.find((item) => item.id === id) ?? null;
}

function evidenceMap(output: LlmNormalizationOutput): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const entry of output.record.evidence) {
    if (
      typeof entry.field === "string" &&
      Array.isArray(entry.paths) &&
      entry.paths.every((path) => typeof path === "string" && path.startsWith("$."))
    ) {
      result[entry.field] = [...new Set(entry.paths)];
    }
  }
  return result;
}

function supportedText(
  value: string | null,
  field: string,
  evidence: Record<string, string[]>,
  warnings: string[],
): string | null {
  const trimmed = value?.trim() || null;
  if (!trimmed) return null;
  if (!evidence[field]?.length) {
    warnings.push(`unsupported_${field}`);
    return null;
  }
  return trimmed;
}

function descriptionWithoutNewUrls(
  description: string | null,
  raw: unknown,
  warnings: string[],
): string | null {
  const text = description?.trim();
  if (!text) return null;
  const rawText = JSON.stringify(raw);
  for (const url of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
    if (!rawText.includes(url)) {
      warnings.push("description_introduced_url");
      return null;
    }
  }
  return text;
}

export function resolveNormalization(input: {
  output: LlmNormalizationOutput | null;
  deterministic: DeterministicFacts;
  captured: DeterministicInput;
  ingestCategory: string;
  profile: NormalizationProfile;
}): ResolvedNormalization {
  const { output, deterministic, captured, ingestCategory, profile } = input;
  const proposed = output?.record ?? null;
  const evidence = output ? evidenceMap(output) : {};
  const warnings = [...deterministic.warnings, ...(proposed?.warnings ?? [])];

  const isPoi =
    deterministic.hardIsPoi === false
      ? false
      : proposed
        ? proposed.is_poi
        : Boolean(deterministic.normalizedName);
  const invalidReason = isPoi
    ? null
    : proposed?.invalid_reason?.trim() || (deterministic.hardIsPoi === false ? "source_hard_exclusion" : "not_a_poi");

  let displayName = isPoi
    ? supportedText(proposed?.display_name ?? null, "display_name", evidence, warnings) ??
      captured.name?.trim() ??
      null
    : null;
  if (displayName && /^q\d+$/i.test(displayName)) {
    warnings.push("id_only_name");
    displayName = null;
  }

  const seriesName =
    isPoi && proposed
      ? proposed.series_name?.trim() &&
        proposed.series_name.trim() === proposed.display_name?.trim() &&
        evidence.display_name?.length
        ? proposed.series_name.trim()
        : supportedText(proposed.series_name, "series_name", evidence, warnings)
      : null;
  const matchName = normalizeName(seriesName ?? displayName ?? "") ?? null;

  const selectedWebsite = proposed
    ? candidateById(deterministic.urlCandidates, proposed.website_candidate_id)
    : null;
  let website = selectedWebsite?.value ?? captured.website;
  let domain = websiteDomain(website);
  if (website && isListingDomain(domain, profile)) {
    warnings.push("listing_url_not_official");
    website = null;
    domain = null;
  }

  const selectedPhone = proposed
    ? candidateById(deterministic.phoneCandidates, proposed.phone_candidate_id)
    : null;
  const selectedEmail = proposed
    ? candidateById(deterministic.emailCandidates, proposed.email_candidate_id)
    : null;

  let startDate = deterministic.startDate;
  let endDate = deterministic.endDate;
  let datePrecision = deterministic.datePrecision;
  if (!startDate && proposed?.starts_at) {
    const parsed = strictDate(proposed.starts_at);
    if (parsed) {
      startDate = parsed.iso;
      datePrecision = proposed.date_precision ?? parsed.precision;
    } else warnings.push("invalid_llm_start_date");
  }
  if (!endDate && proposed?.ends_at) {
    const parsed = strictDate(proposed.ends_at);
    if (parsed) endDate = parsed.iso;
    else warnings.push("invalid_llm_end_date");
  }
  if (startDate && endDate && endDate < startDate) {
    warnings.push("invalid_resolved_date_range");
    if (!deterministic.endDate) endDate = null;
  }

  const proposedCountry =
    proposed?.country_code && /^[A-Za-z]{2}$/.test(proposed.country_code)
      ? proposed.country_code.toUpperCase()
      : null;
  if (proposed?.country_code && !proposedCountry) warnings.push("invalid_llm_country_code");

  const attributes: Record<string, string | number | boolean> = {};
  for (const attribute of proposed?.attributes ?? []) {
    if (
      attribute &&
      typeof attribute.key === "string" &&
      ["string", "number", "boolean"].includes(typeof attribute.value)
    ) {
      attributes[attribute.key] = attribute.value;
    }
  }
  if (proposed?.edition_year !== null && proposed?.edition_year !== undefined) {
    attributes.edition_year = proposed.edition_year;
  }

  const city = proposed
    ? supportedText(proposed.city, "city", evidence, warnings) ?? captured.city
    : captured.city;
  const region = proposed
    ? supportedText(proposed.region, "region", evidence, warnings) ?? captured.region
    : captured.region;
  const address = proposed
    ? supportedText(proposed.address, "address", evidence, warnings) ?? captured.address
    : captured.address;
  const venue = proposed ? supportedText(proposed.venue, "venue", evidence, warnings) : null;

  const status: ResolvedNormalization["status"] = !isPoi
    ? "rejected"
    : !proposed
      ? "degraded"
    : displayName && matchName
      ? warnings.some((warning) => warning.startsWith("unsupported_"))
        ? "degraded"
        : "accepted"
      : "degraded";

  const resultWithoutFingerprint = {
    status,
    isPoi,
    invalidReason,
    entityKind: proposed?.entity_kind ?? (isPoi ? "place" : null),
    displayName,
    matchName,
    editionYear: proposed?.edition_year ?? null,
    aliases: [...new Set(proposed?.aliases?.map((alias) => alias.trim()).filter(Boolean) ?? [])],
    description: descriptionWithoutNewUrls(proposed?.description ?? captured.description, captured.raw, warnings),
    website: website ?? null,
    websiteDomain: domain,
    phone: selectedPhone?.value ?? deterministic.phone,
    email: selectedEmail?.value ?? captured.email,
    address: address ?? null,
    venue,
    city: city ?? null,
    region: region ?? null,
    countryCode: deterministic.countryCode ?? proposedCountry,
    categorySlugs: [ingestCategory],
    startsAt: startDate,
    endsAt: endDate,
    datePrecision,
    attributes,
    fieldEvidence: evidence,
    warnings: [...new Set(warnings)],
  };

  return {
    ...resultWithoutFingerprint,
    matchFingerprint: stableHash({
      isPoi: resultWithoutFingerprint.isPoi,
      matchName: resultWithoutFingerprint.matchName,
      aliases: resultWithoutFingerprint.aliases,
      websiteDomain: resultWithoutFingerprint.websiteDomain,
      phone: resultWithoutFingerprint.phone,
      city: resultWithoutFingerprint.city,
      region: resultWithoutFingerprint.region,
      countryCode: resultWithoutFingerprint.countryCode,
      categorySlugs: resultWithoutFingerprint.categorySlugs,
      startsAt: resultWithoutFingerprint.startsAt,
      endsAt: resultWithoutFingerprint.endsAt,
    }),
  };
}
