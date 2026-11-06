import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicFacts, type DeterministicInput } from "./deterministic.js";
import {
  composeGeneratedName,
  generatePlaceName,
  isPlaceholderName,
  localityLabel,
  realNameFromTags,
} from "./generated-name.js";
import { getNormalizationProfile } from "./profiles.js";
import { resolveNormalization } from "./resolve.js";
import type { LlmNormalizationOutput } from "./contracts.js";

function input(overrides: Partial<DeterministicInput> = {}): DeterministicInput {
  return {
    name: null,
    description: null,
    website: null,
    source_url: null,
    phone: null,
    email: null,
    address: null,
    city: null,
    region: null,
    country_code: null,
    lat: 47.8281865,
    lng: -59.1927891,
    attributes: { osm_tags: { tourism: "caravan_site" } },
    raw: { tourism: "caravan_site" },
    sourceIsPoiHint: null,
    generatedNameCategory: "campground",
    ...overrides,
  };
}

function modelOutput(record: Partial<LlmNormalizationOutput["record"]>): LlmNormalizationOutput {
  return {
    record: {
      record_id: "fixture",
      is_poi: true,
      invalid_reason: null,
      entity_kind: "place",
      display_name: null,
      series_name: null,
      edition_year: null,
      aliases: [],
      description: null,
      venue: null,
      address: null,
      city: null,
      region: null,
      country_code: null,
      website_candidate_id: null,
      phone_candidate_id: null,
      email_candidate_id: null,
      starts_at: null,
      ends_at: null,
      date_precision: null,
      attributes: [],
      warnings: [],
      evidence: [],
      ...record,
    },
  } as LlmNormalizationOutput;
}

function resolve(captured: DeterministicInput, output: LlmNormalizationOutput | null = null) {
  return resolveNormalization({
    output,
    deterministic: buildDeterministicFacts(captured),
    captured,
    ingestCategory: "campground",
    profile: getNormalizationProfile("campground"),
  });
}

test("placeholders are not names; real names are", () => {
  for (const name of [null, "", "  ", "-", "?", "Unnamed", "N/A", "no name", "UNKNOWN"])
    assert.equal(isPlaceholderName(name), true, String(name));
  for (const name of ["Blue Ponds RV Park", "Camping du Lac", "オートキャンプ場", "KOA"])
    assert.equal(isPlaceholderName(name), false, name);
});

test("a real name in another OSM name tag is used, flags like name:signed are not", () => {
  assert.equal(realNameFromTags({ "name:signed": "no", "name:de": "Stellplatz Am See" }), "Stellplatz Am See");
  assert.equal(realNameFromTags({ "name:fr": "Aire du Lac", "name:en": "Lake Area" }), "Lake Area");
  assert.equal(realNameFromTags({ alt_name: "Old Mill;Mill Camp" }), "Old Mill");
  assert.equal(realNameFromTags({ operator: "Town Council", "name:signed": "no" }), null);
});

test("generated names state the kind, qualifiers and locality, never a proper name", () => {
  const generated = generatePlaceName({
    ingestCategory: "campground",
    attributes: {
      osm_tags: {
        tourism: "camp_site",
        operator: "Westward Bound Campgrounds",
        ref: "12",
        "addr:street": "Lake Road",
      },
    },
    raw: {},
    address: null,
    city: "Springfield",
    region: "Oregon",
    countryCode: "US",
    lat: 44,
    lng: -123,
  });
  assert.equal(generated.subject, "Campsite (Westward Bound Campgrounds, ref 12) on Lake Road");
  assert.equal(generated.name, `${generated.subject} near Springfield, United States`);

  const bare = generatePlaceName({
    ingestCategory: "campground",
    attributes: {},
    raw: { tourism: "caravan_site" },
    address: null,
    city: null,
    region: null,
    countryCode: null,
    lat: 47.8281865,
    lng: -59.1927891,
  });
  assert.deepEqual(bare, { subject: "Caravan site", name: "Caravan site at 47.8282, -59.1928" });

  assert.equal(
    generatePlaceName({ ...{ attributes: {}, raw: {}, address: null, city: null, region: null, countryCode: "FR", lat: null, lng: null }, ingestCategory: "botanical_garden" }).name,
    "Botanical garden in France",
  );
  assert.equal(localityLabel({ city: null, region: "Bavaria", countryCode: "de" }), "in Bavaria, Germany");
  assert.equal(localityLabel({ city: "Lyon", region: "Auvergne", countryCode: "FR" }), "near Lyon, France");
  assert.equal(composeGeneratedName("Caravan site", null, null, null), "Caravan site");
});

test("named records' deterministic facts are unchanged (no generated keys, cache stays valid)", () => {
  const facts = buildDeterministicFacts(input({ name: "Blue Ponds RV Park" }));
  assert.equal(facts.normalizedName, "Blue Ponds RV Park");
  assert.equal(Object.hasOwn(facts, "generatedName"), false);
  assert.equal(Object.hasOwn(facts, "generatedNameSubject"), false);
  assert.equal(facts.warnings.includes("source_name_missing_generated_name"), false);
});

test("events and other non-place profiles get no generated name", () => {
  const facts = buildDeterministicFacts(input({ generatedNameCategory: null }));
  assert.equal(facts.normalizedName, null);
  assert.equal(facts.generatedName, undefined);
});

test("a nameless place is accepted with a flagged generated name (deterministic path)", () => {
  const resolved = resolve(input({ city: "Lyon", country_code: "FR" }));
  assert.equal(resolved.isPoi, true);
  assert.equal(resolved.status, "degraded"); // no model output, as for any deterministic-only record
  assert.equal(resolved.displayName, "Caravan site near Lyon, France");
  assert.equal(resolved.matchName, "caravan site near lyon france");
  assert.equal(resolved.attributes.name_generated, true);
  assert.equal(resolved.attributes.generated_name, "Caravan site near Lyon, France");
  assert.equal(resolved.attributes.generated_name_subject, "Caravan site");
  assert.ok(resolved.warnings.includes("source_name_missing_generated_name"));
});

test("the model's display name is ignored for a nameless place", () => {
  const resolved = resolve(
    input({ attributes: { osm_tags: { tourism: "caravan_site", operator: "Camping Co" } } }),
    modelOutput({
      display_name: "Camping Co",
      evidence: [{ field: "display_name", paths: ["$.captured.attributes.osm_tags.operator"] }],
    }),
  );
  assert.equal(resolved.status, "accepted");
  assert.equal(resolved.displayName, "Caravan site (Camping Co) at 47.8282, -59.1928");
  assert.equal(resolved.attributes.name_generated, true);
  assert.ok(resolved.warnings.includes("model_name_ignored_for_nameless_place"));
});

test("a placeholder source name is replaced, a tag name is real", () => {
  const placeholder = resolve(input({ name: "Unnamed" }));
  assert.equal(placeholder.attributes.name_generated, true);
  assert.ok(placeholder.warnings.includes("placeholder_source_name"));

  const tagged = resolve(
    input({ attributes: { osm_tags: { tourism: "caravan_site", "name:de": "Stellplatz Am See" } } }),
  );
  assert.equal(tagged.displayName, "Stellplatz Am See");
  assert.equal(Object.hasOwn(tagged.attributes, "name_generated"), false);
});

test("a source attribute cannot claim or spoof the generated-name facts", () => {
  const named = resolve(
    input({ name: "Blue Ponds RV Park", attributes: { name_generated: true, generated_name: "x" } }),
  );
  assert.equal(named.displayName, "Blue Ponds RV Park");
  assert.equal(Object.hasOwn(named.attributes, "name_generated"), false);
  assert.equal(Object.hasOwn(named.attributes, "generated_name"), false);
});

test("the model can still reject a nameless record that is not a place", () => {
  const resolved = resolve(input(), modelOutput({ is_poi: false, invalid_reason: "region_not_poi" }));
  assert.equal(resolved.isPoi, false);
  assert.equal(resolved.displayName, null);
  assert.equal(Object.hasOwn(resolved.attributes, "name_generated"), false);
});
