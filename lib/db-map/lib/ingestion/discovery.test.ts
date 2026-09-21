import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFiles } from "./inventory-scan.js";
test("discovery hashes versions, includes supported captures, excludes notes/symlinks, and notices removed files", async () => {
  const root = await mkdtemp(join(tmpdir(), "poi-inventory-"));
  try {
    const dir = join(root, "poi");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "data.json"), "[]");
    await writeFile(join(dir, "notes.md"), "notes");
    await writeFile(join(dir, "legacy.kml"), "<kml/>");
    await symlink(join(dir, "data.json"), join(dir, "alias.json"));
    const first = await discoverFiles(root);
    assert.equal(first.length, 2);
    assert.equal(first[0]?.path, "poi/data.json");
    const hash = first[0]?.sha256;
    assert.ok(hash);
    assert.equal(first[0]?.category, null);
    await writeFile(join(dir, "data.json"), "[1]");
    assert.notEqual((await discoverFiles(root))[0]?.sha256, hash);
    await rm(join(dir, "data.json"));
    assert.equal((await discoverFiles(root)).length, 1);
    await rm(dir, { recursive: true });
    await assert.rejects(discoverFiles(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
