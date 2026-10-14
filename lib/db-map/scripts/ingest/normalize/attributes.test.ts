import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAttributes } from "./attributes.js";
import {
  parseNormalizationOutput,
  type LlmNormalizationOutput,
} from "./contracts.js";
import {
  buildDeterministicFacts,
  type DeterministicInput,
} from "./deterministic.js";
import { getNormalizationProfile } from "./profiles.js";
import { resolveNormalization } from "./resolve.js";

const captured: DeterministicInput = {
  name: "Source Camp",
  description: null,
  website: null,
  source_url: null,
  phone: null,
  email: null,
  address: null,
  city: null,
  region: null,
  country_code: "US",
  lat: 40,
  lng: -90,
  sourceIsPoiHint: true,
  attributes: {
    rating: "0.0",
    reviews_count: "0",
    price_low: "12.00",
    wifi: "False",
    pets_allowed: true,
    source: "TheDyrt",
    postal_code: "00123",
    source_id: "0007",
  },
  raw: { shade: false, capacity: 20, nested: { "cost per night": 12 } },
};
const output: LlmNormalizationOutput = {
  record: {
    record_id: "fixture",
    is_poi: true,
    invalid_reason: null,
    entity_kind: "place",
    display_name: "Source Camp",
    series_name: null,
    edition_year: null,
    aliases: [],
    description: null,
    venue: null,
    address: null,
    city: null,
    region: null,
    country_code: "US",
    website_candidate_id: null,
    phone_candidate_id: null,
    email_candidate_id: null,
    starts_at: null,
    ends_at: null,
    date_precision: null,
    attributes: [],
    warnings: [],
    evidence: [{ field: "display_name", paths: ["$.captured.name"] }],
  },
};

test("source attributes survive model omission and deterministic-only normalization", () => {
  for (const proposed of [output, null]) {
    const result = resolveNormalization({
      output: proposed,
      captured,
      deterministic: buildDeterministicFacts(captured),
      ingestCategory: "campground",
      profile: getNormalizationProfile("campground"),
    });
    assert.deepEqual(result.attributes, {
      rating: 0,
      reviews_count: 0,
      price_low: 12,
      wifi: false,
      pets_allowed: true,
      source: "TheDyrt",
      postal_code: "00123",
      source_id: "0007",
    });
    assert.deepEqual(result.fieldEvidence["attributes.rating"], [
      "$.captured.attributes.rating",
    ]);
    assert.equal(result.status, proposed ? "accepted" : "degraded");
    assert.equal(result.countryCode, "US");
  }
});

test("model estimates cannot overwrite captured zero, false, IDs or text", () => {
  const warnings: string[] = [];
  const evidence = { "attributes.rating": ["$.raw.capacity"] };
  const result = resolveAttributes(
    captured,
    [
      { key: "rating", value: 4.5 },
      { key: "wifi", value: true },
      { key: "source_id", value: 7 },
      { key: "pets_allowed", value: "True" },
      { key: "source", value: "Another source" },
    ],
    evidence,
    warnings,
  );
  assert.equal(result.rating, 0);
  assert.equal(result.wifi, false);
  assert.equal(result.source_id, "0007");
  assert.equal(result.source, "TheDyrt");
  assert.ok(warnings.includes("attribute_source_conflict_rating"));
  assert.ok(!warnings.includes("attribute_source_conflict_pets_allowed"));
  assert.deepEqual(evidence["attributes.rating"], [
    "$.captured.attributes.rating",
  ]);
});

test("additional attributes require matching scalar evidence, including zero and false", () => {
  const warnings: string[] = [];
  const result = resolveAttributes(
    captured,
    [
      { key: "shade", value: false },
      { key: "capacity", value: 20 },
      { key: "nightly_cost", value: 12 },
      { key: "pool", value: true },
      { key: "fake", value: 999 },
      { key: "container", value: "anything" },
      { key: "bad_path", value: 12 },
    ],
    {
      "attributes.shade": ["$.raw.shade"],
      "attributes.capacity": ["$.raw.capacity"],
      "attributes.nightly_cost": ['$.raw.nested["cost per night"]'],
      "attributes.pool": ["$.raw.pool"],
      "attributes.fake": ["$.raw.capacity"],
      "attributes.container": ["$.raw.nested"],
      "attributes.bad_path": ['$.raw["bad\\z"]'],
    },
    warnings,
  );
  assert.equal(result.shade, false);
  assert.equal(result.capacity, 20);
  assert.equal(result.nightly_cost, 12);
  for (const key of ["pool", "fake", "container", "bad_path"]) {
    assert.equal(Object.hasOwn(result, key), false);
    assert.ok(warnings.includes(`attribute_dropped_${key}`));
  }
});

test("unsafe keys, inherited paths and contradictory proposals cannot activate", () => {
  const warnings: string[] = [];
  const result = resolveAttributes(
    { ...captured, raw: { first: 1, second: 2 } },
    [
      { key: "__proto__", value: "pollution" },
      { key: "inherited", value: "function" },
      { key: "count", value: 1 },
      { key: "count", value: 2 },
      { key: "count", value: 1 },
    ],
    {
      "attributes.inherited": ["$.raw.toString"],
      "attributes.count": ["$.raw.first", "$.raw.second"],
    },
    warnings,
  );
  assert.equal(Object.hasOwn(result, "__proto__"), false);
  assert.equal(Object.hasOwn(result, "inherited"), false);
  assert.equal(Object.hasOwn(result, "count"), false);
});

test("discarding an extra attribute preserves record quality but unsupported core fields still degrade", () => {
  for (const city of [null, "Invented City"]) {
    const result = resolveNormalization({
      output: {
        record: {
          ...output.record,
          city,
          attributes: [{ key: "pool", value: true }],
        },
      },
      captured,
      deterministic: buildDeterministicFacts(captured),
      ingestCategory: "campground",
      profile: getNormalizationProfile("campground"),
    });
    assert.equal(Object.hasOwn(result.attributes, "pool"), false);
    assert.equal(result.attributes.rating, 0);
    assert.equal(result.attributes.wifi, false);
    assert.ok(result.warnings.includes("attribute_dropped_pool"));
    assert.equal(result.status, city ? "degraded" : "accepted");
    if (city) assert.ok(result.warnings.includes("unsupported_city"));
  }
});

test("JSON-object fallback cannot bypass attribute/evidence type validation", () => {
  assert.equal(parseNormalizationOutput(output, "fixture"), output);
  for (const changes of [
    { attributes: [null] },
    { attributes: [{ key: "wifi", value: null }] },
    { attributes: [{ key: "rating", value: Infinity }] },
    { attributes: [{ key: "", value: true }] },
    { evidence: [null] },
    { evidence: [{ field: "name", paths: [123] }] },
    { warnings: [123] },
    { edition_year: 2026.5 },
    { entity_kind: "made_up" },
    { date_precision: "hour" },
  ])
    assert.throws(() =>
      parseNormalizationOutput(
        { record: { ...output.record, ...changes } },
        "fixture",
      ),
    );
});
