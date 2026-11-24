import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { musicBrainzVenueResultIssue } from "../geocode.js";
import { recordsFor } from "../orchestrator.js";
import { resolveSourceFile } from "../source-file.js";
import { mapGenericRecord } from "./generic.js";
import { withVenueAddress } from "./musicbrainz.js";

const address = "1 Victoria Street, Hamilton, New Zealand 3204";
const heldAt = {
  "target-type": "place",
  direction: "forward",
  "type-id": "e2c6f697-07dc-38b1-be0b-83d740165532",
  place: {
    id: "565357f7-9b84-4206-b180-f892c1ea0c3f",
    name: "The Meteor",
    address,
    area: { type: "City", name: "Hamilton" },
  },
};
const event = {
  mbid: "512acc4a-d123-4347-9e19-4e4d6c100a00",
  name: "Hamtown Smakdown 2018, Day 1",
  city: "Hamilton",
  country: "New Zealand",
  relations: [heldAt],
};

test("registered MusicBrainz v2 preserves event identity and raw evidence and projects the single venue's address", async () => {
  const source = await resolveSourceFile(
    "data/poi/music-festivals/apis/musicbrainz_festivals_01_of_16.json",
    "music_festival",
  );
  assert.equal(source.extractorVersion, "2");
  const dir = await mkdtemp(join(tmpdir(), "mb-venue-"));
  try {
    const absolutePath = join(dir, "sample.json");
    await writeFile(absolutePath, JSON.stringify([event]));
    const records = [];
    for await (const record of recordsFor({ ...source, absolutePath }))
      records.push(record);
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.equal(record.source_record_id, event.mbid);
    assert.equal(record.address, address);
    assert.equal(record.attributes?.musicbrainz_venue_mbid, heldAt.place.id);
    assert.equal(record.attributes?.musicbrainz_venue_name, heldAt.place.name);
    assert.deepEqual(record.raw, event);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("leave existing locations and ambiguous or unrelated place relations alone", () => {
  for (const override of [
    { address: "Original address" },
    { attributes: { street_address: "Original address" } },
    { lat: 1, lng: 2 },
    { city: "Auckland" },
    { relations: [heldAt, { ...heldAt, place: { id: "another" } }] },
    { relations: [{ ...heldAt, "type-id": "other" }] },
    { relations: [{ ...heldAt, direction: "backward" }] },
    { relations: [{ ...heldAt, "target-type": "area" }] },
    { relations: [null, { ...heldAt, place: null }] },
  ]) {
    const record = mapGenericRecord(
      { ...event, ...override },
      { sourceSlug: "musicbrainz" },
    )!;
    assert.equal(withVenueAddress(record), record);
  }
});

test("check a precise venue against street-number or independent name evidence", () => {
  const hit = (details: Record<string, string>) => ({
    precision: "point" as const,
    raw_response: { address: details },
  });
  assert.equal(
    musicBrainzVenueResultIssue(
      address,
      "The Meteor",
      "address",
      hit({ house_number: "1/657", road: "Victoria Street" }),
    ),
    "venue_house_number_mismatch",
  );
  assert.equal(
    musicBrainzVenueResultIssue(
      address,
      "The Meteor",
      "address",
      hit({ house_number: "1", road: "Victoria Street" }),
    ),
    null,
  );
  assert.equal(
    musicBrainzVenueResultIssue(
      address,
      "The Meteor",
      "address",
      hit({ house_number: "1", road: "Other Street" }),
    ),
    "venue_address_unconfirmed",
  );
  assert.equal(
    musicBrainzVenueResultIssue(
      address,
      "The Meteor",
      "venue",
      hit({ name: "Meteor Theatre" }),
    ),
    null,
  );
  assert.equal(
    musicBrainzVenueResultIssue(
      address,
      "The Meteor",
      "venue",
      hit({ name: "Meteor Theatre", house_number: "1/657" }),
    ),
    "venue_house_number_mismatch",
  );
  assert.equal(
    musicBrainzVenueResultIssue(
      address,
      "The Meteor",
      "venue",
      hit({ name: "Meteor Coffee" }),
    ),
    "venue_address_unconfirmed",
  );
  assert.equal(
    musicBrainzVenueResultIssue(address, "The Meteor", "venue", {
      precision: "city",
    }),
    "venue_address_unconfirmed",
  );
});
