import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFestivalLocation } from "./thatfestivalsite.js";
import { resolveSourceFile } from "../source-file.js";
import { recordsFor } from "../orchestrator.js";
import { resolveLocation } from "../location.js";

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
  assert.equal(source.extractorVersion, "3");
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
    records++;
  }
  assert.equal(records, 1415);
});
