import assert from "node:assert/strict";
import { parseNormalizationOutput, type LlmNormalizationOutput } from "./contracts.js";
import { buildDeterministicFacts, strictDate, type DeterministicInput } from "./deterministic.js";
import { getNormalizationProfile } from "./profiles.js";
import { resolveNormalization } from "./resolve.js";

assert.equal(strictDate("2027-06-31"), null, "invalid calendar dates must be rejected");
assert.deepEqual(strictDate("2027-06-30"), { iso: "2027-06-30", precision: "day" });

const captured: DeterministicInput = {
  name: "Test Festival 2027",
  description: null,
  website: "https://ra.co/events/123",
  source_url: "https://directory.example/test",
  phone: null,
  email: null,
  address: null,
  city: "Test City",
  region: null,
  country_code: "US",
  lat: null,
  lng: null,
  attributes: { start_date: "2027-06-31" },
  raw: { name: "Test Festival 2027", is_festival: false, start_date: "2027-06-31" },
  sourceIsPoiHint: true,
};
const facts = buildDeterministicFacts(captured);
assert.equal(facts.hardIsPoi, false, "explicit source false flag must be authoritative");
assert.equal(facts.startDate, null);
assert.ok(facts.warnings.includes("invalid_source_start_date"));

const proposed: LlmNormalizationOutput = {
  record: {
    record_id: "record-1",
    is_poi: true,
    invalid_reason: null,
    entity_kind: "event_occurrence",
    display_name: "Test Festival",
    series_name: "Test Festival",
    edition_year: 2027,
    aliases: [],
    description: null,
    venue: null,
    address: null,
    city: "Test City",
    region: null,
    country_code: "US",
    website_candidate_id: "url_1",
    phone_candidate_id: null,
    email_candidate_id: null,
    starts_at: "2027-06-31",
    ends_at: null,
    date_precision: "day",
    attributes: [],
    warnings: [],
    evidence: [
      { field: "display_name", paths: ["$.captured.name"] },
      { field: "city", paths: ["$.captured.city"] },
    ],
  },
};
const resolved = resolveNormalization({
  output: proposed,
  deterministic: facts,
  captured,
  categorySlugs: ["music_festival"],
  profile: getNormalizationProfile("event"),
});
assert.equal(resolved.isPoi, false, "LLM cannot override a hard source exclusion");
assert.equal(resolved.startsAt, null, "invalid LLM date must not activate");
assert.equal(resolved.website, null, "listing domains cannot become official websites");

assert.throws(
  () => parseNormalizationOutput({ record: { ...proposed.record, record_id: "wrong" } }, "record-1"),
  /record_id mismatch/,
);

console.log("Hybrid normalization golden checks passed.");
