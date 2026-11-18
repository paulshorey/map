import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RawRecord } from "../types.js";
import { recordsFor } from "../orchestrator.js";
import { resolveSourceFile } from "../source-file.js";
import { criticalStagesExtractor } from "./critical-stages.js";
import { parseGenericRecords } from "./generic.js";

const capture =
  "data/poi/art-parades/street-arts/critical_stages_festivals.json";
async function collect(records: AsyncIterable<RawRecord>) {
  const result: RawRecord[] = [];
  for await (const record of records) result.push(record);
  return result;
}
const read = (file: string) => collect(criticalStagesExtractor.parse(file));

test("Critical Stages retains raw rows, prior IDs and distinct stable guide listings", async () => {
  const source = await resolveSourceFile(capture, "art_parade");
  const raw = JSON.parse(await readFile(source.absolutePath, "utf8"));
  const before = await collect(
    parseGenericRecords(source.absolutePath, { sourceSlug: "critical_stages" }),
  );
  const repaired = await collect(recordsFor(source));

  assert.equal(source.extractorVersion, "critical-stages-v1");
  assert.deepEqual(
    repaired.map((row) => row.raw),
    raw,
  );
  assert.equal(repaired.length, 241);
  const accepted = repaired.filter(
    (row) => row.source_record_id && !row.extraction_rejection,
  );
  assert.equal(accepted.length, 234);
  assert.equal(new Set(accepted.map((row) => row.source_record_id)).size, 234);
  for (const [i, row] of before.entries()) {
    if (row.source_record_id && i !== 181) {
      assert.equal(
        repaired[i]?.source_record_id,
        row.source_record_id,
        `raw row ${i + 1}`,
      );
    }
  }
  const older = repaired[148]!;
  const newer = repaired[181]!;
  assert.equal(newer.source_record_id, `${older.source_record_id}:guide-20`);
  assert.notEqual(older.source_url, newer.source_url);
  assert.deepEqual(
    [older.attributes?.festival_month, newer.attributes?.festival_month],
    ["August", "September"],
  );
  assert.equal(newer.attributes?.start_date, undefined);
  assert.equal(repaired[12]?.city, "Denver");
  assert.equal(raw[12].city, null);
  assert.deepEqual(repaired[12]?.attributes?.locality_evidence, {
    city: "Denver",
    country_code: "US",
    source_url:
      "https://www.critical-stages.org/14/international-theatre-and-performing-arts-festival-guide/",
  });
  assert.deepEqual(
    repaired
      .filter((row) => row.extraction_rejection)
      .map((row) => row.extraction_rejection!.code)
      .sort(),
    [
      "not_a_listing",
      "not_a_listing",
      "not_a_listing",
      "source_review_required",
      "source_review_required",
      "source_review_required",
      "source_review_required",
    ],
  );

  const temp = await mkdtemp(join(tmpdir(), "critical-stages-test-"));
  try {
    const reversed = join(temp, "reversed.json");
    await writeFile(reversed, JSON.stringify([...raw].reverse()));
    assert.deepEqual((await read(reversed)).reverse(), repaired);

    const sameIssue = join(temp, "same-issue.json");
    const pif = raw[181];
    await writeFile(
      sameIssue,
      JSON.stringify([pif, { ...pif, description: "different text" }]),
    );
    const rows = await read(sameIssue);
    assert.equal(rows[0]?.source_record_id, rows[1]?.source_record_id);
    assert.notDeepEqual(rows[0]?.raw, rows[1]?.raw);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
