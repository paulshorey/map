import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  POI_ROOT,
  resolveSourceFile,
} from "../../scripts/ingest/source-file.js";

test("source file resolution accepts capture paths and rejects paths outside the capture tree", async () => {
  const path = "data/poi/rv_campgrounds_data/thedyrt/rv_campgrounds.csv";
  const source = await resolveSourceFile(path, "campground");
  assert.equal(source.absolutePath, resolve(POI_ROOT, "rv_campgrounds_data/thedyrt/rv_campgrounds.csv"));
  assert.equal(source.logicalPath, path);
  assert.equal(source.source.meta.slug, "thedyrt");
  assert.equal(source.file.category, "campground");

  await assert.rejects(resolveSourceFile("README.md", "campground"), /Source file must be under/);
  await assert.rejects(resolveSourceFile("data/poi-outside/file.csv", "campground"), /Source file must be under/);
});
