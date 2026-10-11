import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSourceFile } from "../../scripts/ingest/source-file.js";
import { recordsFor } from "../../scripts/ingest/orchestrator.js";

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
    "data/poi/rv_campgrounds_data/ridb/facilities.csv",
    "campground",
  );
  for await (const record of recordsFor(ridb)) {
    assert.equal(record.source_record_id, "257029");
    assert.equal(record.name, "Temple Mountain Campground East");
    assert.equal(record.lat, 38.65677222);
    assert.equal(record.lng, -110.661225);
    assert.ok(record.description);
    assert.equal(record.source_record_id_kind, "natural");
    break;
  }
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
