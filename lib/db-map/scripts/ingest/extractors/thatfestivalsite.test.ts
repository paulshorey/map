import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFestivalLocation } from "./thatfestivalsite.js";
import { resolveSourceFile } from "../source-file.js";
import { recordsFor } from "../orchestrator.js";
import { resolveLocation } from "../location.js";
import { buildDeterministicFacts, type DeterministicInput } from "../normalize/deterministic.js";
import type { LlmNormalizationOutput } from "../normalize/contracts.js";
import { getNormalizationProfile } from "../normalize/profiles.js";
import { resolveNormalization } from "../normalize/resolve.js";
import { requestPacket } from "../normalize/runner.js";

test("country-as-city and state-as-country survive as hints, not authoritative fields", () => {
  const raw = {
    id: 1336,
    name: "1Dance Africa",
    city: "Australia",
    country: "Australia",
    venue: "Hordern Pavilion",
    latitude: -33.8941187,
    longitude: 151.2242143,
    url: "https://thatfestivalsite.com/festival/1Dance%20Africa",
    start_date: "2019-10-10",
    status: "inactive",
  };
  const record = mapFestivalLocation(raw)!;
  assert.equal(record.source_record_id, "1336");
  assert.equal(record.raw, raw);
  assert.deepEqual([record.lat, record.lng], [raw.latitude, raw.longitude]);
  assert.equal(record.city, undefined);
  assert.equal(record.country_code, undefined);
  assert.equal(record.attributes!.country_name, undefined);
  assert.equal(
    (record.attributes!.source_location_hints as any).country,
    "Australia",
  );
  assert.equal(record.attributes!.start_date, "2019-10-10");
  const state = mapFestivalLocation({
    ...raw,
    id: 335,
    city: "Indio",
    country: "California",
  })!;
  assert.equal(
    (state.attributes!.source_location_hints as any).country,
    "California",
  );
  assert.equal(state.country_code, undefined);
});

test("coordinate country can differ from a listing hint without discarding the venue point", () => {
  const record = mapFestivalLocation({
    id: 273,
    name: "Big Day Out",
    city: "Australia",
    country: "Australia",
    latitude: -36.8649559,
    longitude: 174.7277154,
  })!;
  const result = resolveLocation(
    { country_code: null, city: null, region: null, address: null },
    {
      country_code: "NZ",
      city: "Auckland",
      region: "Auckland",
      address: "Stadium address",
      postcode: null,
      region_code: null,
      distance_m: 0,
      provider: "locationiq",
      attribution: "fixture",
    },
  );
  assert.equal(result.fields.country_code, "NZ");
  assert.equal(result.fields.city, "Auckland");
  assert.equal(result.provenance.country_code, "reverse_geocode");
  assert.deepEqual([record.lat, record.lng], [-36.8649559, 174.7277154]);
  assert.equal(
    (record.attributes!.source_location_hints as any).country,
    "Australia",
  );
});

test("registered source preserves every natural ID, raw value and coordinate in the current capture", async () => {
  const source = await resolveSourceFile(
    "data/poi/music-festivals/directories/thatfestivalsite_festivals.json",
    "music_festival",
  );
  assert.equal(source.extractorVersion, "4");
  const ids = new Set<string>();
  let records = 0;
  for await (const record of recordsFor(source)) {
    assert.ok(record.source_record_id);
    assert.ok(!ids.has(record.source_record_id));
    ids.add(record.source_record_id);
    const raw = record.raw as any;
    assert.deepEqual([record.lat, record.lng], [raw.latitude, raw.longitude]);
    assert.equal(record.city, undefined);
    assert.equal(record.country_code, undefined);
    assert.equal(
      (record.attributes!.source_location_hints as any).country,
      raw.country,
    );
    if (record.source_record_id === "273") {
      const row = {...record, id: "fixture", source_slug: "thatfestivalsite"} as Parameters<typeof requestPacket>[0];
      const packet = requestPacket(row, "event", {} as Parameters<typeof requestPacket>[2]);
      const view = packet as {raw: typeof raw; captured: {attributes: Record<string, unknown>}};
      assert.equal(raw.lineup.length, 1867);
      assert.equal((record.attributes!.lineup as unknown[]).length, 1867);
      assert.equal(view.raw.lineup, undefined);
      assert.equal(view.captured.attributes.lineup, undefined);
      assert.equal(view.raw.lineup_count, 1867);
      assert.equal(view.raw.country, raw.country);
      assert.equal(view.raw.start_date, raw.start_date);
      assert.equal(view.raw.latitude, raw.latitude);
      assert.deepEqual(packet.omitted_context_fields, ["lineup"]);
      const generic = requestPacket({...row, source_slug: "jambase"}, "event", {} as Parameters<typeof requestPacket>[2]);
      assert.equal((generic.raw as any).lineup, raw.lineup);
      assert.ok(JSON.stringify(packet).length < JSON.stringify(generic).length / 2);
    }
    records++;
  }
  assert.equal(records, 1415);
});

test("coordinate lookup policy rejects model and deterministic administrative labels while preserving the source address", () => {
  const record = mapFestivalLocation({
    id: 273, name: "Big Day Out", city: "Australia", country: "Australia",
    latitude: -36.8649559, longitude: 174.7277154,
  })!;
  assert.equal(record.attributes!.location_admin_policy_version, 1);
  const captured: DeterministicInput = {
    name: record.name!, description: null, website: null, source_url: null,
    phone: null, email: null, address: "Official captured address",
    city: "Australia", region: "Queensland", country_code: "AU",
    lat: record.lat!, lng: record.lng!, attributes: record.attributes!, raw: record.raw,
    sourceIsPoiHint: true,
  };
  const output: LlmNormalizationOutput = { record: {
    record_id: "273", is_poi: true, invalid_reason: null, entity_kind: "event_series",
    display_name: "Big Day Out", series_name: null, edition_year: null, aliases: [],
    description: null, venue: null, address: "Official captured address",
    city: "Australia", region: "Queensland", country_code: "AU",
    website_candidate_id: null, phone_candidate_id: null, email_candidate_id: null,
    starts_at: null, ends_at: null, date_precision: null, attributes: [], warnings: [],
    evidence: [
      {field: "display_name", paths: ["$.captured.name"]},
      {field: "address", paths: ["$.captured.address"]},
      {field: "city", paths: ["$.raw.city"]},
      {field: "region", paths: ["$.captured.region"]},
      {field: "country_code", paths: ["$.raw.country"]},
    ],
  }};
  for (const proposal of [output, null]) {
    const resolved = resolveNormalization({
      output: proposal, captured, deterministic: buildDeterministicFacts(captured),
      ingestCategory: "music_festival", profile: getNormalizationProfile("event"),
    });
    assert.deepEqual([resolved.city, resolved.region, resolved.countryCode], [null, null, null]);
    assert.equal(resolved.address, captured.address);
    assert.equal(resolved.fieldEvidence.city, undefined);
    assert.ok(resolved.warnings.includes("administrative_fields_deferred_to_coordinate_lookup"));
    const enriched = resolveLocation({
      city: resolved.city, region: resolved.region,
      country_code: resolved.countryCode, address: resolved.address,
    }, {
      city: "Auckland", region: "Auckland", country_code: "NZ", address: "Approximate road",
      postcode: null, region_code: null, distance_m: 0, provider: "locationiq", attribution: "fixture",
    });
    assert.equal(enriched.fields.country_code, "NZ");
    assert.equal(enriched.fields.city, "Auckland");
    assert.equal(enriched.fields.address, captured.address);
    assert.equal(enriched.provenance.address, "source");
  }
});
