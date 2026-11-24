import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { musicBrainzVenueResultIssue } from "../geocode.js";
import {
  genericRecordsFor,
  recordsFor,
  runOrchestration,
} from "../orchestrator.js";
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

const sourceFile =
  "data/poi/music-festivals/apis/musicbrainz_festivals_01_of_16.json";

test("registered MusicBrainz v2 preserves identity and raw evidence from the saved capture", async () => {
  const source = await resolveSourceFile(sourceFile, "music_festival");
  assert.equal(source.extractorVersion, "2");
  const eventRecord = async (records: ReturnType<typeof recordsFor>) => {
    for await (const record of records) {
      if (record.source_record_id === event.mbid) return record;
    }
    assert.fail("Hamilton event is missing from the saved shard");
  };
  const previous = await eventRecord(genericRecordsFor(source));
  const current = await eventRecord(recordsFor(source));
  assert.equal(previous.address, undefined);
  assert.equal(previous.attributes?.musicbrainz_venue_mbid, undefined);
  assert.equal(current.source_record_id, previous.source_record_id);
  assert.equal(current.source_record_id_kind, previous.source_record_id_kind);
  assert.equal(current.address, address);
  assert.equal(current.attributes?.musicbrainz_venue_mbid, heldAt.place.id);
  assert.equal(current.attributes?.musicbrainz_venue_name, heldAt.place.name);
  assert.deepEqual(current.raw, previous.raw);
});

test("a saved v1 run fails before writes when resumed from the v2 checkout", async () => {
  let queries = 0;
  const db = {
    on() {},
    async query(sql: string) {
      queries++;
      assert.match(
        sql,
        /^SELECT r\.\*,f\.logical_path,v\.file_sha256,v\.extractor_version/,
      );
      return {
        rows: [
          {
            id: "v1-run",
            logical_path: sourceFile,
            extractor_version: "1",
            options: { file: sourceFile, category: "music_festival" },
          },
        ],
      };
    },
  } as unknown as Pool;
  await assert.rejects(
    runOrchestration(db, {
      file: sourceFile,
      category: "music_festival",
      resume: "v1-run",
      dryRun: false,
      noLlm: true,
      retryFailed: false,
      shadow: false,
    }),
    /Extractor version changed; start a new run/,
  );
  assert.equal(queries, 1);
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

const meteor = {
  address,
  venue: "The Meteor",
  city: "Hamilton",
  country_code: "NZ",
};
const point = (details: Record<string, unknown>) => ({
  precision: "point" as const,
  raw_response: { address: details },
});

test("linked venue accepts a whole street and house number or a corroborated venue name", () => {
  for (const details of [
    { house_number: "1", road: "Victoria St." },
    { amenity: "Meteor Theatre", road: "Victoria Street" },
    { name: "Meteor Theatre", city: "Hamilton" },
  ]) {
    assert.equal(musicBrainzVenueResultIssue(meteor, point(details)), null);
  }
  assert.equal(
    musicBrainzVenueResultIssue(
      { ...meteor, address: "Europalaan 26, Genk" },
      point({ road: "Europalaan", house_number: "26" }),
    ),
    null,
  );
});

test("a venue name cannot override address or country contradictions", () => {
  const named = { name: "Meteor Theatre", city: "Hamilton" };
  for (const [details, reason] of [
    [
      { ...named, house_number: "1/657", road: "Victoria Street" },
      "venue_house_number_mismatch",
    ],
    [
      { ...named, house_number: "1", road: "Victoria Avenue" },
      "venue_road_mismatch",
    ],
    [{ ...named, country_code: "ca" }, "venue_country_mismatch"],
    [{ ...named, city: "Cambridge" }, "venue_address_unconfirmed"],
    [{ ...named, name: "Meteor Coffee" }, "venue_address_unconfirmed"],
  ] as const) {
    assert.equal(musicBrainzVenueResultIssue(meteor, point(details)), reason);
  }
  assert.equal(
    musicBrainzVenueResultIssue(
      { ...meteor, venue: "Main Stage" },
      point({ name: "Stage", city: "Hamilton" }),
    ),
    "venue_address_unconfirmed",
  );
  for (const hit of [
    { precision: "city" as const },
    { precision: "point" as const },
    {
      ...point({ ...named, road: "Victoria Street" }),
      raw_response: { class: "highway", address: named },
    },
  ] as const) {
    assert.equal(
      musicBrainzVenueResultIssue(meteor, hit),
      "venue_address_unconfirmed",
    );
  }
});

test("different saved addresses for Output in Naha require more than the same venue and city", () => {
  // The saved shards contain two place MBIDs for Output in the same city.
  const oldVenue = {
    address: "沖縄県那覇市久米2-5-7 久米ビル地下一階",
    venue: "Output",
    city: "Naha",
    country_code: "JP",
  };
  const otherVenue = point({
    name: "Output",
    city: "Naha",
    country_code: "jp",
  });
  assert.equal(
    musicBrainzVenueResultIssue(oldVenue, otherVenue),
    "venue_address_unconfirmed",
  );
});

test("range endpoints can agree while compound house numbers stay intact", () => {
  const venue = {
    address: "Weteringschans 6-8, Amsterdam",
    venue: "Paradiso",
    city: "Amsterdam",
  };
  assert.equal(
    musicBrainzVenueResultIssue(
      venue,
      point({ name: "Paradiso", road: "Weteringschans", house_number: "6" }),
    ),
    null,
  );
  assert.equal(
    musicBrainzVenueResultIssue(
      { ...venue, address: "Weteringschans 6–8, Amsterdam" },
      point({ road: "Weteringschans", house_number: "8" }),
    ),
    null,
  );
  for (const [address, road, house_number] of [
    ["52-19 Flushing Ave, Queens", "Flushing Avenue", "52"],
    ["2/323 William St, Northbridge", "William Street", "323"],
  ] as const) {
    assert.equal(
      musicBrainzVenueResultIssue(
        { ...venue, address },
        point({ road, house_number }),
      ),
      "venue_house_number_mismatch",
    );
  }
});

test("address prefixes and a missing comma before the city do not create false conflicts", () => {
  for (const [address, city, road, house_number] of [
    ["422 E 6th St Austin, TX 78701", "Austin", "E 6th Street", "422"],
    ["618 W 6th St Ste 200 Austin, TX 78701", "Austin", "W 6th Street", "618"],
    ["484 Queen Street W Toronto", "Toronto", "Queen Street West", "484"],
    ["Pier 17, 89 South St", "New York", "South Street", "89"],
  ] as const) {
    assert.equal(
      musicBrainzVenueResultIssue(
        { address, venue: null, city },
        point({ road, house_number }),
      ),
      null,
      address,
    );
  }
  assert.equal(
    musicBrainzVenueResultIssue(
      { ...meteor, address: "1 Victoria Street Hamilton" },
      point({
        name: "Meteor Theatre",
        city: "Hamilton",
        road: "Other Street",
        house_number: "1",
      }),
    ),
    "venue_road_mismatch",
  );
  assert.equal(
    musicBrainzVenueResultIssue(
      { address: "Pier 17", venue: "Pier 17", city: "New York" },
      point({
        name: "Pier 17",
        city: "New York",
        road: "South Street",
        house_number: "89",
      }),
    ),
    "venue_address_unconfirmed",
  );
});
