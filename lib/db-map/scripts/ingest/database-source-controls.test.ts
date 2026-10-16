import assert from "node:assert/strict";
import { test } from "node:test";
import { recordsFor } from "./orchestrator.js";
import { resolveSourceFile } from "./source-file.js";

test("database controls resolve exact Taipei and JamBase identities and captured location evidence", async () => {
  const taipei = [];
  for await (const row of recordsFor(
    await resolveSourceFile(
      "data/poi/art-fairs/biennials/biennial_association.json",
      "art_fair",
    ),
  )) {
    if (row.source_record_id === "f5e2e5adfc6dfcccd19fa6a1ab04b779663f4297")
      taipei.push(row);
  }
  assert.equal(taipei.length, 1);
  assert.equal(taipei[0]!.name, "Taipei Biennial");
  assert.deepEqual([taipei[0]!.lat, taipei[0]!.lng], [25.0731, 121.526]);
  assert.equal(taipei[0]!.attributes?.country_name, "Taiwan");
  assert.equal(taipei[0]!.attributes?.edition_year, "2023");
  const jambase = [];
  for await (const row of recordsFor(
    await resolveSourceFile(
      "data/poi/music-festivals/apis/jambase_festivals.json",
      "music_festival",
    ),
  )) {
    if (row.source_record_id === "jambase:16210265") jambase.push(row);
  }
  assert.equal(jambase.length, 1);
  const row = jambase[0]!;
  assert.equal(row.name, "NoMad Jazz Festival");
  assert.deepEqual(
    [row.lat, row.lng, row.city, row.region, row.country_code],
    [40.7422, -73.988, "New York", "New York", "US"],
  );
  assert.equal(row.attributes?.venue_address, "11 Madison Avenue");
  const raw = row.raw as any;
  assert.equal(raw.venue.stateCode, "NY");
  assert.equal(raw.venue.postalCode, "10010");
  assert.equal(raw.startDate, "2026-08-07");
  assert.equal(raw.endDate, "2026-08-08");
});
