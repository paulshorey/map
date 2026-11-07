import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSourceFile } from "../../scripts/ingest/source-file.js";
import { recordsFor } from "../../scripts/ingest/orchestrator.js";
import { requestPacket } from "../../scripts/ingest/normalize/runner.js";

test("registered Songkick and Festival Atlas wrapper captures yield identifiable records", async () => {
  for (const file of [
    "data/poi/music-festivals/apis/songkick_festivals.json",
    "data/poi/music-festivals/directories/festivalatlas_festivals.json",
  ]) {
    const source = await resolveSourceFile(file, "music_festival");
    assert.equal(source.file.wrapperPath, "festivals");
    assert.equal(source.extractorVersion, "2");
    let count = 0;
    for await (const record of recordsFor(source)) {
      assert.ok(record.name);
      assert.ok(record.source_record_id);
      if (++count === 3) break;
    }
    assert.equal(count, 3);
  }
});

test("registered campground CSVs retain facility fields and OSM type-qualified identities", async () => {
  const ridb = await resolveSourceFile(
    "data/poi/rv_campgrounds_data/ridb/facilities_with_addresses.csv",
    "campground",
  );
  let ridbSeen = 0;
  let ridbFixture = false;
  for await (const record of recordsFor(ridb)) {
    if (ridbSeen++ === 0) {
      assert.equal(record.source_record_id, "257029");
      assert.equal(record.name, "Temple Mountain Campground East");
      assert.equal(record.lat, 38.65677222);
      assert.equal(record.lng, -110.661225);
      assert.ok(record.description);
      assert.equal(record.source_record_id_kind, "natural");
    }
    if (record.source_record_id !== "261822") continue;
    ridbFixture = true;
    // Locality comes from the export's FacilityAddresses; verbatim rows stay in attributes.
    assert.equal(record.address, "6563 Hauser Dam Rd");
    assert.equal(record.city, "Helena");
    assert.equal(record.region, "MT");
    assert.equal(record.country_code, "US");
    assert.equal(record.attributes?.postal_code, "59602");
    assert.ok(Array.isArray(record.attributes?.facility_addresses));
    // The model never sees the verbatim (incl. rejected mailing/office) address rows.
    const row = {
      ...record,
      id: "fixture",
      source_slug: "ridb",
    } as unknown as Parameters<typeof requestPacket>[0];
    const packet = requestPacket(
      row,
      "campground",
      {} as Parameters<typeof requestPacket>[2],
    ) as {
      raw: Record<string, unknown>;
      captured: { address: string; attributes: Record<string, unknown> };
    };
    assert.equal(packet.raw.facility_addresses, undefined);
    assert.equal(packet.captured.attributes.facility_addresses, undefined);
    assert.equal(packet.captured.address, "6563 Hauser Dam Rd");
    break;
  }
  assert.ok(ridbFixture, "RIDB fixture facility 261822 not found");
  const osm = await resolveSourceFile(
    "data/poi/rv_campgrounds_data/osm/caravan_sites.csv",
    "campground",
  );
  let count = 0;
  for await (const record of recordsFor(osm)) {
    assert.match(record.source_record_id, /^(node|way|relation)\/\d+$/);
    assert.equal(record.source_record_id_kind, "natural");
    assert.notEqual(record.region, "north_america");
    assert.ok(record.raw);
    if (++count === 3) break;
  }
  assert.equal(count, 3);
});
