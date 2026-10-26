import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assessLocation, type AssessmentInput } from "./location-assessment.js";
import { LOCATION_GEOCODER_VERSION, LOCATION_VERSION } from "./location.js";

const packet = JSON.parse(
  readFileSync(
    new URL("./fixtures/location-assessment-review.json", import.meta.url),
    "utf8",
  ),
);
for (const c of packet.cases)
  test(`review packet: ${c.source} / ${c.name} / ${c.case_id}`, () => {
    const input = structuredClone(c.input) as AssessmentInput;
    const before = JSON.stringify(input);
    const assessment = assessLocation(input);
    assert.equal(assessment.status, c.expected_status);
    assert.equal(JSON.stringify(input), before, "raw evidence must not change");
    assert.equal(assessment.evidence.venue_verified, false);
    assert.equal(assessment.evidence.edition_verified, false);
    if (c.expected_status !== "accepted") {
      assert.equal(assessment.accepted_point, null);
      assert.ok(assessment.reasons.includes(c.expected_reason));
    } else {
      assert.equal(assessment.accepted_kind, "inferred");
      assert.equal(
        (assessment.evidence.coordinate_evidence as any).source_coordinates,
        null,
      );
    }
  });

export function fixtureInput(): AssessmentInput {
  const source = {
    lat: 30,
    lng: -97,
    kind: "source",
    origin: "source_coordinates",
    precision: "point",
    label: null,
    query: null,
  };
  const inferred = {
    ...source,
    lat: 30.0001,
    kind: "inferred",
    origin: "listed_address_geocode",
    query: "Venue, Austin, US",
  };
  return {
    observation_id: "observation",
    normalization_id: "normalization",
    geocode_id: "geocode",
    captured: { city: "Austin", country_code: "US", lat: 30, lng: -97 },
    point: { lat: 30, lng: -97 },
    coordinate_source: "source",
    coordinate_precision: "point",
    geocoder_version: LOCATION_GEOCODER_VERSION,
    validation: {
      version: LOCATION_VERSION,
      normalization_id: "normalization",
      point: { lat: 30, lng: -97 },
      coordinate_evidence: {
        source_coordinates: source,
        inferred_coordinates: inferred,
      },
      listed: { city: "Austin", country_code: "US" },
      forward: {
        country_filter: "US",
        result: { ...inferred, country_code: "US" },
      },
      reverse: null,
      warnings: [],
    },
  };
}
test("nearby precise points accept source without losing the inferred observation", () => {
  const result = assessLocation(fixtureInput());
  assert.equal(result.status, "accepted");
  assert.equal(result.accepted_kind, "source");
  assert.ok((result.evidence.distance_m as number) > 0);
  assert.ok((result.evidence.coordinate_evidence as any).inferred_coordinates);
  assert.equal(result.evidence.forward_country_filter, "US");
});
test("equal points retain both evidence records", () => {
  const input = fixtureInput(),
    v = input.validation as any;
  v.coordinate_evidence.inferred_coordinates.lat = 30;
  v.forward.result.lat = 30;
  const result = assessLocation(input);
  assert.equal(result.status, "accepted");
  assert.equal(result.evidence.distance_m, 0);
  assert.equal(
    Object.values(result.evidence.coordinate_evidence as object).filter(Boolean)
      .length,
    2,
  );
});
for (const kind of ["source", "inferred"] as const)
  test(`single ${kind} requires bound country and locality reverse agreement`, () => {
    const input = fixtureInput(),
      v = input.validation as any;
    v.coordinate_evidence[
      kind === "source" ? "inferred_coordinates" : "source_coordinates"
    ] = null;
    if (kind === "inferred") {
      input.point = { lat: 30.0001, lng: -97 };
      v.point = input.point;
      input.coordinate_source = "geocode";
    }
    assert.equal(assessLocation(input).status, "needs_review");
    v.reverse = { country_code: "US", city: "Austin", distance_m: 10 };
    assert.equal(assessLocation(input).status, "accepted");
    assert.equal(assessLocation(input).accepted_kind, kind);
    v.reverse.city = "Dallas";
    assert.equal(assessLocation(input).status, "needs_review");
  });
for (const reason of [
  "country",
  "region",
  "distance",
  "coarse",
  "no_country",
  "invalid_source",
  "forward_binding",
  "source_binding",
  "captured_country",
  "captured_source",
  "precision_missing",
  "projection_text",
])
  test(`uncertain evidence stays advisory: ${reason}`, () => {
    const input = fixtureInput(),
      v = input.validation as any;
    if (reason === "captured_country") input.captured!.country_code = "CH";
    if (reason === "captured_source") input.captured!.lat = 31;
    if (reason === "precision_missing")
      delete v.coordinate_evidence.source_coordinates.precision;
    if (reason === "projection_text")
      input.projection_location = { country_code: "CH" };
    if (reason === "country") v.reverse = { country_code: "NG" };
    if (reason === "region") v.warnings = ["coordinate_region_conflict"];
    if (reason === "distance") {
      v.coordinate_evidence.inferred_coordinates.lat = 40;
      v.forward.result.lat = 40;
      const far = assessLocation(input);
      assert.equal(far.status, "needs_review");
      assert.equal(far.accepted_point, null);
      assert.ok(Number(far.evidence.distance_m) > 250);
      return;
    }
    if (reason === "coarse")
      v.coordinate_evidence.inferred_coordinates.precision = "city";
    if (reason === "no_country") v.listed.country_code = null;
    if (reason === "invalid_source")
      v.coordinate_evidence.source_coordinates.lat = 91;
    if (reason === "forward_binding") v.forward.result.lat = 20;
    if (reason === "source_binding") input.coordinate_source = "geocode";
    assert.equal(assessLocation(input).status, "needs_review");
    assert.equal(assessLocation(input).accepted_point, null);
  });
test("missing points stay unlocated and reverse results cannot manufacture candidates", () => {
  const input = fixtureInput(),
    v = input.validation as any;
  v.coordinate_evidence = {
    source_coordinates: null,
    inferred_coordinates: null,
  };
  v.reverse = {
    lat: 30,
    lng: -97,
    country_code: "US",
    city: "Austin",
    distance_m: 0,
  };
  assert.equal(assessLocation(input).status, "unlocated");
});
test("changed inputs invalidate assessments; key order does not", () => {
  const input = fixtureInput(),
    hash = assessLocation(input).input_hash;
  assert.equal(
    assessLocation(
      Object.fromEntries(
        Object.entries(input).reverse(),
      ) as unknown as AssessmentInput,
    ).input_hash,
    hash,
  );
  for (const key of [
    "observation_id",
    "normalization_id",
    "geocode_id",
    "geocoder_version",
  ] as const) {
    const changed = structuredClone(input);
    changed[key] = "changed";
    assert.notEqual(assessLocation(changed).input_hash, hash);
  }
  const changed = structuredClone(input);
  changed.point.lat = 31;
  assert.equal(assessLocation(changed).status, "needs_review");
  assert.notEqual(assessLocation(changed).input_hash, hash);
});
for (const [name, source] of [
  ["Gurtenfestival", "jambase"],
  ["Big Day Out", "thatfestivalsite"],
])
  test(`cached contradiction survives representation upgrade: ${name}`, () => {
    const c = packet.cases.find(
      (c: any) => c.name === name && c.source === source,
    );
    assert.ok(c);
    const input = structuredClone(c.input) as AssessmentInput,
      v = input.validation as any;
    input.geocoder_version = LOCATION_GEOCODER_VERSION;
    v.version = LOCATION_VERSION;
    v.normalization_id = input.normalization_id;
    v.point = input.point;
    if (!v.listed)
      v.listed = {
        hints: (input.captured?.attributes as any)?.source_location_hints,
        country_code: (input.captured?.attributes as any)?.country_name,
      };
    v.coordinate_evidence = {
      source_coordinates: {
        ...input.point,
        kind: "source",
        origin: "source_coordinates",
        precision: "point",
      },
      inferred_coordinates: null,
    };
    const result = assessLocation(input);
    assert.equal(result.status, "needs_review");
    assert.ok(result.reasons.includes("location_text_coordinate_conflict"));
  });
