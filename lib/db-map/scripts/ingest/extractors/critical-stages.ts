import { readFile } from "node:fs/promises";
import type { Extractor, RawRecord } from "../types.js";
import { parseGenericRecords } from "./generic.js";

type ReviewRow = {
  issue: number;
  name: string;
} & (
  | {
      disposition: "recover_locality";
      listing_id: string;
      city: string;
      country_code: string;
      evidence_url?: string;
    }
  | { disposition: "needs_review" | "exclude"; reason: string }
);

const guidePath =
  /^(https:\/\/www\.critical-stages\.org\/(14|20)\/international-theatre-and-performing-arts-festival-guide)\/?$/;
const reviewPath = new URL(
  "../../../../../data/poi-research/reviews/critical-stages-guide.json",
  import.meta.url,
);
const listingKey = (issue: number, name: string) => `${issue}:${name}`;

function applyReview(
  record: RawRecord,
  decisions: Map<string, ReviewRow>,
): RawRecord {
  const guide = guidePath.exec(record.source_url ?? "");
  if (!guide || !record.name) return record;
  const issue = Number(guide[2]);
  // Issue 14 retains the legacy ID already used by the old extraction. Issue 20
  // is a separate listing of that series, with no claim about an event date.
  if (
    issue === 20 &&
    record.name === "International Puppet Theatre Festival PIF" &&
    record.source_record_id_kind === "synthetic" &&
    record.city === "Zagreb" &&
    (record.raw as { country?: string }).country === "Croatia"
  ) {
    return {
      ...record,
      source_record_id: `${record.source_record_id}:guide-20`,
    };
  }

  const decision = decisions.get(listingKey(issue, record.name));
  if (!decision) return record;

  if (decision.disposition === "recover_locality") {
    if (record.source_record_id) return record;
    return {
      ...record,
      source_record_id: decision.listing_id,
      source_record_id_kind: "natural",
      city: decision.city,
      country_code: decision.country_code,
      attributes: {
        ...record.attributes,
        locality_evidence: {
          city: decision.city,
          country_code: decision.country_code,
          source_url: decision.evidence_url ?? `${guide[1]}/`,
        },
      },
    };
  }

  return {
    ...record,
    extraction_rejection: {
      code:
        decision.disposition === "exclude"
          ? "not_a_listing"
          : "source_review_required",
      reason: decision.reason,
    },
  };
}

export const criticalStagesExtractor: Extractor = {
  slug: "critical_stages",
  async *parse(file) {
    const { schema_version, rows } = JSON.parse(
      await readFile(reviewPath, "utf8"),
    ) as {
      schema_version: number;
      rows: ReviewRow[];
    };
    if (schema_version !== 1)
      throw new Error("Unsupported Critical Stages review version");
    const decisions = new Map(
      rows.map((row) => [listingKey(row.issue, row.name), row]),
    );
    if (decisions.size !== rows.length)
      throw new Error("Duplicate Critical Stages review key");
    for await (const record of parseGenericRecords(file, {
      sourceSlug: "critical_stages",
    })) {
      yield applyReview(record, decisions);
    }
  },
};
