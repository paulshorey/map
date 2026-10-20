import { createHash, randomUUID } from "node:crypto";
import type {
  LocationReviewOptions,
  LocationReviewRow,
  LocationReviewSample,
} from "../../../sql/ingestion-location-review.js";
import { countryToCode } from "../normalize/country.js";

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): ObjectValue =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as ObjectValue) : {};
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;
const at = (v: unknown, path: string[]): unknown =>
  path.reduce<unknown>((o, key) => object(o)[key], v) ?? null;
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fold = (v: unknown): string =>
  (text(v) ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const point = (lat: unknown, lng: unknown): lat is number =>
  typeof lat === "number" &&
  typeof lng === "number" &&
  Number.isFinite(lat) &&
  Number.isFinite(lng) &&
  Math.abs(lat) <= 90 &&
  Math.abs(lng) <= 180 &&
  !(lat === 0 && lng === 0);
function distance(a: ObjectValue, b: ObjectValue): number | null {
  if (!point(a.lat, a.lng) || !point(b.lat, b.lng)) return null;
  const rad = Math.PI / 180,
    lat1 = Number(a.lat),
    lat2 = Number(b.lat);
  const h =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((Number(b.lng) - Number(a.lng)) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(Math.min(1, h)));
}
export interface EvidenceField {
  stage:
    | "capture"
    | "extraction"
    | "normalization"
    | "geocode"
    | "canonical"
    | "projection";
  table: string;
  row_id: string;
  column: string;
  path: string[];
  value: unknown;
}
export interface Finding {
  code: string;
  kind: "conflict" | "difference" | "coverage";
  fields: string[];
}
export interface ReviewCase {
  case_id: string;
  evidence_hash: string;
  source: string;
  source_record_id: string;
  stratum: string;
  context: ObjectValue;
  lineage: ObjectValue;
  fields: Record<string, EvidenceField>;
  findings: Finding[];
  listed: Record<string, string | null>;
  reverse_address: string | null;
  reverse_comparable: boolean;
}
export interface ReviewPacket {
  version: "location-review-v1" | "location-review-v2";
  packet_id: string;
  observed_at: string;
  selection: LocationReviewOptions;
  population: LocationReviewSample["population"];
  cases: ReviewCase[];
  limitations: string[];
}

export function makeReviewCase(row: LocationReviewRow): ReviewCase {
  const fields: Record<string, EvidenceField> = {},
    findings: Finding[] = [];
  const add = (
    id: string,
    stage: EvidenceField["stage"],
    table: string,
    row_id: string,
    column: string,
    path: string[],
    value: unknown,
  ) => {
    fields[id] = { stage, table, row_id, column, path, value: value ?? null };
  };
  const note = (code: string, kind: Finding["kind"], ...ids: string[]) =>
    findings.push({ code, kind, fields: ids });
  // Only known top-level capture aliases and the registered JamBase venue shape.
  // Unknown shapes retain captured fields; no recursive guess at organizer/billing addresses.
  const rawPaths: Record<string, string[][]> = {
    country: [["country"], ["country_name"]],
    country_code: [["country_code"]],
    address: [["address"], ["street_address"]],
    city: [["city"]],
    region: [["region"], ["state"], ["state_region"]],
    lat: [["lat"], ["latitude"]],
    lng: [["lng"], ["lon"], ["longitude"]],
  };
  if (row.source === "jambase")
    Object.assign(rawPaths, {
      country: [["venue", "country"]],
      country_code: [["venue", "countryCode"]],
      address: [["venue", "streetAddress"]],
      city: [["venue", "city"]],
      region: [["venue", "state"]],
      lat: [["venue", "lat"]],
      lng: [["venue", "lng"]],
    });
  for (const [key, paths] of Object.entries(rawPaths)) {
    const path = paths.find((p) => at(row.raw, p) !== null) ?? paths[0]!;
    add(
      `listed.${key}`,
      "capture",
      "research_poi_observations",
      row.observation_id,
      "raw",
      path,
      at(row.raw, path),
    );
  }
  const names = ["address", "city", "region", "country_code", "lat", "lng"];
  for (const key of names) {
    add(
      `captured.${key}`,
      "extraction",
      "research_poi_observations",
      row.observation_id,
      "captured",
      [key],
      at(row.captured, [key]),
    );
    if (key !== "lat" && key !== "lng")
      add(
        `normalized.${key}`,
        "normalization",
        "research_poi_normalizations",
        row.normalization_id,
        key,
        [],
        row.normalized[key],
      );
    add(
      `projection.${key}`,
      "projection",
      "research_pois",
      row.research_id,
      key,
      [],
      row.projection[key],
    );
    const attribute = !["address", "lat", "lng"].includes(key);
    add(
      `canonical.${key}`,
      "canonical",
      "canonical_pois",
      row.canonical_id,
      attribute ? "attributes" : key,
      attribute ? [key] : [],
      attribute ? at(row.canonical, ["attributes", key]) : row.canonical[key],
    );
    if (row.geocode_id)
      add(
        `reverse.${key}`,
        "geocode",
        "research_poi_geocodes",
        row.geocode_id,
        "validation",
        ["reverse", key],
        at(row.geocode, ["validation", "reverse", key]),
      );
  }
  add(
    "captured.location_hints",
    "extraction",
    "research_poi_observations",
    row.observation_id,
    "captured",
    ["attributes", "source_location_hints"],
    at(row.captured, ["attributes", "source_location_hints"]),
  );
  add(
    "captured.country_name",
    "extraction",
    "research_poi_observations",
    row.observation_id,
    "captured",
    ["attributes", "country_name"],
    at(row.captured, ["attributes", "country_name"]),
  );
  add(
    "normalized.field_evidence",
    "normalization",
    "research_poi_normalizations",
    row.normalization_id,
    "field_evidence",
    [],
    row.normalized.field_evidence,
  );
  add(
    "canonical.field_provenance",
    "canonical",
    "canonical_pois",
    row.canonical_id,
    "field_provenance",
    [],
    row.canonical.field_provenance,
  );
  add(
    "canonical.builder_version",
    "canonical",
    "canonical_poi_builds",
    row.build_id,
    "builder_version",
    [],
    row.builder_version,
  );
  for (const slot of ["source_coordinates", "inferred_coordinates"]) {
    add(
      `canonical.coordinate_evidence.${slot}`,
      "canonical",
      "canonical_pois",
      row.canonical_id,
      "attributes",
      ["coordinate_evidence", slot],
      at(row.canonical, ["attributes", "coordinate_evidence", slot]),
    );
    if (row.geocode_id)
      add(
        `geocode.coordinate_evidence.${slot}`,
        "geocode",
        "research_poi_geocodes",
        row.geocode_id,
        "validation",
        ["coordinate_evidence", slot],
        at(row.geocode, ["validation", "coordinate_evidence", slot]),
      );
  }
  for (const key of [
    "normalizer_version",
    "venue",
    "edition_year",
    "attributes",
    "display_name",
    "description",
    "website",
    "starts_at",
    "ends_at",
  ])
    add(
      `normalized.${key}`,
      "normalization",
      "research_poi_normalizations",
      row.normalization_id,
      key,
      [],
      row.normalized[key],
    );
  for (const key of ["name", "description", "website", "starts_at", "ends_at"])
    add(
      `canonical.${key}`,
      "canonical",
      "canonical_pois",
      row.canonical_id,
      key,
      [],
      row.canonical[key],
    );
  if (
    !at(row.canonical, [
      "attributes",
      "coordinate_evidence",
      "source_coordinates",
    ]) &&
    !at(row.canonical, [
      "attributes",
      "coordinate_evidence",
      "inferred_coordinates",
    ])
  )
    note(
      "named_coordinate_evidence_not_stored",
      "coverage",
      "canonical.coordinate_evidence.source_coordinates",
      "canonical.coordinate_evidence.inferred_coordinates",
      "canonical.builder_version",
    );
  const geo = object(row.geocode),
    validation = object(geo.validation),
    reverse = object(validation.reverse);
  if (row.geocode_id) {
    add(
      "geocode.artifact_normalization_id",
      "geocode",
      "research_poi_geocodes",
      row.geocode_id,
      "normalization_id",
      [],
      geo.normalization_id,
    );
    for (const key of [
      "lat",
      "lng",
      "precision",
      "provider",
      "query_norm",
      "status",
      "provider_version",
    ])
      add(
        `geocode.${key}`,
        "geocode",
        "research_poi_geocodes",
        row.geocode_id,
        key,
        [],
        geo[key],
      );
    for (const key of [
      "point",
      "normalization_id",
      "lookup_state",
      "provenance",
      "warnings",
      "version",
      "listed",
      "forward",
      "forward_query_norm",
    ])
      add(
        `geocode.${key}`,
        "geocode",
        "research_poi_geocodes",
        row.geocode_id,
        "validation",
        [key],
        validation[key],
      );
    for (const key of ["distance_m", "postcode", "region_code", "attribution"])
      add(
        `reverse.${key}`,
        "geocode",
        "research_poi_geocodes",
        row.geocode_id,
        "validation",
        ["reverse", key],
        reverse[key],
      );
  }
  const failedBindingFields = [
    ...(geo.normalization_id !== row.normalization_id
      ? ["geocode.artifact_normalization_id"]
      : []),
    ...(validation.normalization_id !== row.normalization_id
      ? ["geocode.normalization_id"]
      : []),
    ...(distance(geo, object(validation.point)) !== 0
      ? ["geocode.lat", "geocode.lng", "geocode.point"]
      : []),
    ...(geo.status !== "resolved" ? ["geocode.status"] : []),
  ];
  const reverseComparable =
    !!row.geocode_id &&
    !!text(reverse.country_code) &&
    failedBindingFields.length === 0;
  if (!row.geocode_id || !text(reverse.country_code))
    note("reverse_not_available", "coverage", "canonical.lat", "canonical.lng");
  else if (!reverseComparable)
    note(
      "reverse_lineage_or_point_unbound",
      "coverage",
      ...failedBindingFields,
    );
  const value = (id: string) => fields[id]?.value;
  const listed: Record<string, string | null> = {};
  for (const key of ["country", "country_code", "address", "city", "region"]) {
    // An explicitly cleared source hint remains a hint, not a canonical assertion.
    listed[key] =
      text(value(`listed.${key}`)) ?? text(value(`captured.${key}`));
  }
  listed.country ??= text(value("captured.country_name"));
  const countryNameField = text(value("listed.country"))
    ? "listed.country"
    : "captured.country_name";
  if (listed.country && !countryToCode(listed.country))
    note("listed_country_not_recognized", "difference", countryNameField);
  const lc =
    countryToCode(listed.country_code) ?? countryToCode(listed.country);
  const countryCodeField = text(value("listed.country_code"))
    ? "listed.country_code"
    : "captured.country_code";
  const rawCountryField = countryToCode(listed.country_code)
    ? countryCodeField
    : countryNameField;
  if (
    lc &&
    countryToCode(listed.country) &&
    lc !== countryToCode(listed.country)
  )
    note(
      "listed_country_fields_disagree",
      "conflict",
      countryNameField,
      countryCodeField,
    );
  if (reverseComparable) {
    if (lc && lc !== countryToCode(text(reverse.country_code)))
      note(
        "listed_country_vs_reverse",
        "conflict",
        rawCountryField,
        "reverse.country_code",
        "geocode.lat",
        "geocode.lng",
      );
    for (const key of ["city", "region", "address"]) {
      const a = listed[key],
        b = text(reverse[key]);
      if (!a || !b || fold(a) === fold(b)) continue;
      if (
        key === "region" &&
        [
          reverse.region_code,
          text(reverse.region_code)?.split("-").slice(1).join("-"),
        ].some((v) => fold(v) === fold(a))
      )
        continue;
      const left = text(value(`listed.${key}`))
        ? `listed.${key}`
        : `captured.${key}`;
      note(`listed_${key}_vs_reverse`, "difference", left, `reverse.${key}`);
    }
    if (typeof reverse.distance_m === "number" && reverse.distance_m > 1000)
      note("reverse_result_too_distant", "difference", "reverse.distance_m");
  }
  if (
    lc &&
    text(value("canonical.country_code")) &&
    lc !== countryToCode(text(value("canonical.country_code")))
  )
    note(
      "listed_country_vs_canonical",
      "conflict",
      rawCountryField,
      "canonical.country_code",
      "canonical.field_provenance",
    );
  if (
    lc &&
    text(value("normalized.country_code")) &&
    lc !== countryToCode(text(value("normalized.country_code")))
  )
    note(
      "listed_country_vs_normalization",
      "difference",
      rawCountryField,
      "normalized.country_code",
    );
  for (const key of ["country_code", "city", "region", "address"]) {
    if (!text(value(`canonical.${key}`)))
      note(`canonical_${key}_missing`, "coverage", `canonical.${key}`);
  }
  if (!point(row.canonical.lat, row.canonical.lng))
    note(
      "canonical_point_invalid",
      "conflict",
      "canonical.lat",
      "canonical.lng",
    );
  const capturedPoint = {
    lat: value("captured.lat"),
    lng: value("captured.lng"),
  };
  const extractionDistance = distance(
    { lat: value("listed.lat"), lng: value("listed.lng") },
    capturedPoint,
  );
  if (extractionDistance !== null && extractionDistance > 1)
    note(
      "listed_point_changed_at_extraction",
      "difference",
      "listed.lat",
      "listed.lng",
      "captured.lat",
      "captured.lng",
    );
  const changed = distance(capturedPoint, geo);
  if (changed !== null && changed > 1)
    note(
      "captured_point_changed_at_geocode",
      "difference",
      "captured.lat",
      "captured.lng",
      "geocode.lat",
      "geocode.lng",
    );
  const mergedDistance = distance(row.canonical, geo);
  if (mergedDistance !== null && mergedDistance > 1000)
    note(
      "canonical_point_far_from_member",
      "difference",
      "canonical.lat",
      "canonical.lng",
      "geocode.lat",
      "geocode.lng",
      "canonical.field_provenance",
    );
  if (
    row.projection.active_normalization_id !== row.normalization_id ||
    row.projection.active_geocode_id !== row.geocode_id
  )
    note(
      "projection_newer_or_different_than_build",
      "coverage",
      "projection.country_code",
      "canonical.field_provenance",
    );
  const lineage = {
    research_id: row.research_id,
    canonical_id: row.canonical_id,
    build_id: row.build_id,
    builder_version: row.builder_version ?? null,
    normalization_id: row.normalization_id,
    observation_id: row.observation_id,
    geocode_id: row.geocode_id,
    source_file_version_id: row.source_file_version_id,
    logical_path: row.logical_path,
    raw_content_hash: row.raw_content_hash,
    capture_hash: row.capture_hash,
    completion: row.completion,
    completion_scope:
      "binding states whether a successful checkpoint certifies this normalization, observation, or record identity only. missing_verification is an explicitly selected build member without that proof; the current build may be newer than any verification.",
  };
  const context = {
    name:
      row.canonical.name ?? row.normalized.display_name ?? row.captured.name,
    description:
      text(row.normalized.description)?.slice(0, 500) ??
      text(row.canonical.description)?.slice(0, 500) ??
      null,
    starts_at: row.normalized.starts_at ?? row.canonical.starts_at,
    ends_at: row.normalized.ends_at ?? row.canonical.ends_at,
    source_url: row.captured.source_url ?? null,
    website: row.normalized.website ?? row.captured.website ?? null,
    location_policy: at(row.captured, ["attributes", "location_admin_policy"]),
  };
  const reverseAddress = Object.keys(reverse).length
    ? [
        reverse.address,
        reverse.city,
        reverse.region,
        reverse.postcode,
        reverse.country_code,
      ]
        .map(text)
        .filter(Boolean)
        .join(", ")
    : null;
  return {
    case_id: digest([
      row.build_id,
      row.research_id,
      row.observation_id,
      row.normalization_id,
      row.geocode_id,
    ]).slice(0, 20),
    evidence_hash: digest({ context, lineage, fields }),
    source: row.source,
    source_record_id: row.source_record_id,
    stratum: row.stratum,
    context,
    lineage,
    fields,
    findings,
    listed,
    reverse_address: reverseAddress,
    reverse_comparable: reverseComparable,
  };
}

export function makePacket(
  sample: LocationReviewSample,
  selection: LocationReviewOptions,
): ReviewPacket {
  return {
    version: "location-review-v2",
    packet_id: randomUUID(),
    observed_at: sample.observed_at,
    selection,
    population: sample.population,
    cases: sample.rows.map(makeReviewCase),
    limitations: [
      "Candidates are disagreements or coverage gaps, not adjudicated errors. Text differences may be aliases, nearby municipalities, venue entrances or different editions.",
      "Reverse fields describe the stored query point; this is not independent proof that the point belongs to the event. Addresses are assembled from saved parsed components, not the original full provider response.",
      "Zero provider calls. Missing bound reverse evidence stays unassessed; no cache lookup, forward lookup, LLM call or repair is performed.",
      "Priority-ranked risk cases plus seed-ordered baseline/no-reverse cases are balanced across source/stratum. This is a diagnostic sample, not an unbiased estimate of source error rates. A baseline case can have newly detected differences.",
      "One case is one current canonical-build/source-member pair. Multi-source canonicals can appear more than once; source observations must not be counted as independent geocoder evidence.",
      "Completion evidence can bind the current normalization, observation, or only source/record identity. record_identity_only cases do not prove today's artifacts were verified. Seeded sampling excludes members without a succeeded managed record checkpoint.",
      "Explicit canonical selection includes linked build members without verification and marks them missing_verification. Named coordinate slots remain null when historical artifacts did not store them; this alone is not an ingestion defect.",
      "For explicit selection, population counts describe the selected canonical IDs only. The source/build member cap is enforced without silent truncation.",
    ],
  };
}

const cell = (v: unknown) =>
  String(v ?? "—")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ");
export function renderPacket(packet: ReviewPacket, details = true): string {
  const suspicious = packet.cases.filter((c) =>
    c.findings.some((f) => f.kind !== "coverage"),
  );
  const rest = packet.cases.filter((c) => !suspicious.includes(c));
  const lines = [
    "# Location evidence review",
    "",
    `Packet: ${packet.packet_id}. Snapshot: ${packet.observed_at}. Selected ${packet.cases.length} source/build pairs for ${new Set(packet.cases.map((c) => c.lineage.canonical_id)).size} distinct POIs.`,
    "",
    ...packet.limitations.map((s) => `- ${s}`),
    "",
  ];
  for (const [heading, cases] of [
    ["Candidate inconsistencies", suspicious],
    ["Comparison / coverage sample", rest],
  ] as const) {
    lines.push(
      `## ${heading}`,
      "",
      "| Case / event and captured edition | Listed country | Listed address / locality | Stored reverse address | Findings |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const c of cases)
      lines.push(
        `| ${cell(c.case_id)} · ${cell(c.context.name)} · ${cell(c.context.starts_at)} (${cell(c.source)} / ${cell(c.source_record_id)}) | ${cell([c.listed.country, c.listed.country_code].filter(Boolean).join(" / "))} | ${cell([c.listed.address, c.listed.city, c.listed.region].filter(Boolean).join(", "))} | ${cell(c.reverse_address)}${c.reverse_comparable ? "" : " (unassessed)"} | ${cell(c.findings.map((f) => f.code).join(", "))} |`,
      );
    lines.push("");
  }
  lines.push(
    "## Evidence and field review",
    "",
    "Copy field IDs into decisions.template.json. Judge reverse fields separately for event_location and coordinate_lookup; an accurate lookup of a bad point is not a provider failure. Use incorrect only for a reviewed field, and cite the edition-specific venue evidence. Do not substitute an organizer's office address for the venue.",
    "",
  );
  if (!details)
    return lines
      .concat(
        "Full context, field IDs and physical table/column/JSON paths: field-lineage.md and packet.json.",
        "",
      )
      .join("\n");
  for (const c of packet.cases) {
    lines.push(
      `### ${cell(c.case_id)} — ${cell(c.context.name)}`,
      "",
      `Context: ${cell(c.context.description)}`,
      "",
      `Source URL: ${cell(c.context.source_url)}. Website: ${cell(c.context.website)}.`,
      "",
      `Canonical ID: ${cell(c.lineage.canonical_id)}. Build ID: ${cell(c.lineage.build_id)}.`,
      "",
      "| Field ID | Value | Step | Table · row · column · JSON path |",
      "| --- | --- | --- | --- |",
    );
    for (const [id, f] of Object.entries(c.fields))
      lines.push(
        `| ${cell(id)} | ${cell(typeof f.value === "object" && f.value !== null ? JSON.stringify(f.value) : f.value)} | ${f.stage} | ${f.table} · ${cell(f.row_id)} · ${f.column} · ${cell(f.path.length ? "/" + f.path.join("/") : "(column)")} |`,
      );
    lines.push("");
  }
  return lines.join("\n");
}

export function decisionTemplate(packet: ReviewPacket) {
  return {
    version: packet.version,
    packet_id: packet.packet_id,
    reviewer: "",
    reviewed_at: "",
    cases: packet.cases.map((c) => ({
      case_id: c.case_id,
      evidence_hash: c.evidence_hash,
      field_reviews: [],
    })),
  };
}

/** Offline analysis only. Labels never authorize a database repair or precedence change. */
export function summarizeReviews(packet: ReviewPacket, input: unknown) {
  const decisions = object(input);
  if (
    !["location-review-v1", "location-review-v2"].includes(packet.version) ||
    decisions.version !== packet.version ||
    decisions.packet_id !== packet.packet_id
  )
    throw new Error("Review packet/version mismatch");
  if (
    !text(decisions.reviewer) ||
    !text(decisions.reviewed_at) ||
    !Number.isFinite(Date.parse(String(decisions.reviewed_at)))
  )
    throw new Error("Set reviewer and an ISO reviewed_at timestamp");
  if (!Array.isArray(decisions.cases))
    throw new Error("cases must be an array");
  const seen = new Set<string>(),
    groups = new Map<string, ObjectValue>();
  let reviewed = 0;
  for (const value of decisions.cases) {
    const entry = object(value),
      c = packet.cases.find((c) => c.case_id === entry.case_id);
    if (
      !c ||
      c.evidence_hash !== entry.evidence_hash ||
      c.evidence_hash !==
        digest({ context: c.context, lineage: c.lineage, fields: c.fields })
    )
      throw new Error("Unknown case or changed/stale evidence");
    if (!Array.isArray(entry.field_reviews))
      throw new Error("field_reviews must be an array");
    for (const value of entry.field_reviews) {
      const review = object(value),
        id = String(review.field_id),
        f = Object.hasOwn(c.fields, id) ? c.fields[id] : undefined;
      if (
        !f ||
        !["correct", "incorrect", "uncertain", "not_applicable"].includes(
          String(review.verdict),
        )
      )
        throw new Error("Unknown field or verdict");
      if (
        !["event_location", "coordinate_lookup"].includes(
          String(review.scope),
        ) ||
        (review.scope === "coordinate_lookup" && !id.startsWith("reverse."))
      )
        throw new Error(
          "Use event_location, or coordinate_lookup for reverse fields only",
        );
      if (
        (review.verdict === "correct" || review.verdict === "incorrect") &&
        !text(review.note) &&
        !text(review.evidence_url)
      )
        throw new Error(
          "Reviewed correct/incorrect fields need a note or evidence URL",
        );
      const key = `${c.case_id}:${id}:${review.scope}`;
      if (seen.has(key)) throw new Error("Duplicate field judgment");
      seen.add(key);
      reviewed++;
      const groupKey = JSON.stringify([
        c.source,
        c.stratum,
        f.stage,
        f.table,
        f.column,
        f.path,
        review.scope,
      ]);
      const group = groups.get(groupKey) ?? {
        source: c.source,
        stratum: c.stratum,
        stage: f.stage,
        table: f.table,
        column: f.column,
        path: f.path,
        scope: review.scope,
        correct: 0,
        incorrect: 0,
        uncertain: 0,
        not_applicable: 0,
      };
      group[String(review.verdict)] = Number(group[String(review.verdict)]) + 1;
      groups.set(groupKey, group);
    }
  }
  return {
    packet_id: packet.packet_id,
    reviewer: decisions.reviewer,
    reviewed_at: decisions.reviewed_at,
    reviewed_fields: reviewed,
    groups: [...groups.values()],
    interpretation:
      "Counts are manual judgments on this diagnostic sample, grouped by source, selection stratum, field, stage and correctness scope. Uncertain/NA are not errors. Do not infer population accuracy, provider failure, automatic repairs or global precedence from these counts. Preserve the packet and dated decision revisions.",
  };
}
