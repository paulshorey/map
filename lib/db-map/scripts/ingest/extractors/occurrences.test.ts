import assert from "node:assert/strict";
import { test } from "node:test";
import { mapGenericRecord, separateOccurrences } from "./generic.js";
import type { RawRecord } from "../types.js";

async function ids(raws: Array<Record<string, unknown>>) {
  const mapped = raws.map(
    (raw) => mapGenericRecord(raw, { sourceSlug: "fixture" })!,
  );
  async function* stream() {
    yield* mapped;
  }
  const out: RawRecord[] = [];
  for await (const record of separateOccurrences(stream, "fixture"))
    out.push(record);
  return { before: mapped.map((r) => r.source_record_id), after: out };
}
const market = (
  start_date: string | undefined,
  extra: Record<string, unknown> = {},
) => ({
  name: "FARMERS MARKET",
  city: "CLINTON TWP",
  state: "MI",
  ...(start_date ? { start_date } : {}),
  ...extra,
});

test("repeated occurrences of one event get their own identity, whatever the order", async () => {
  const dates = ["2026-05-09", "2026-06-13", "2026-07-11"];
  const { before, after } = await ids(dates.map((d) => market(d)));
  assert.equal(new Set(before).size, 1, "name and locality alone collide");
  assert.equal(new Set(after.map((r) => r.source_record_id)).size, 3);
  assert.deepEqual(
    after.map((r) => r.identity_inputs?.edition),
    dates,
  );
  const reversed = await ids([...dates].reverse().map((d) => market(d)));
  assert.deepEqual(
    reversed.after.map((r) => r.source_record_id).reverse(),
    after.map((r) => r.source_record_id),
    "an occurrence keeps its ID when the capture is reordered",
  );
});

test("a year distinguishes occurrences when there is no date", async () => {
  const { after } = await ids([
    { name: "The Parade", city: "Nantes", country: "France", year: 1992 },
    { name: "The Parade", city: "Nantes", country: "France", year: 1994 },
  ]);
  assert.equal(new Set(after.map((r) => r.source_record_id)).size, 2);
  assert.equal(after[1]!.identity_inputs?.edition, "1994");
});

test("records that cannot be told apart are left for extraction to report", async () => {
  // No date at all, and the same date twice: nothing to distinguish them by.
  const undated = await ids([
    market(undefined, { booth_fee: 10 }),
    market(undefined, { booth_fee: 20 }),
  ]);
  assert.equal(new Set(undated.after.map((r) => r.source_record_id)).size, 1);
  assert.ok(
    undated.after.every((r) => !r.identity_inputs?.edition),
    "undated repeats are not marked as occurrences",
  );
  const sameDate = await ids([
    market("2026-05-09"),
    market("2026-06-13", { booth_fee: 10 }),
    market("2026-06-13", { booth_fee: 20 }),
  ]);
  assert.equal(new Set(sameDate.after.map((r) => r.source_record_id)).size, 2);
});

test("a file without repeats, and records with their own IDs, are untouched", async () => {
  const distinct = await ids([
    market("2026-05-09"),
    { name: "Art Fair", city: "Austin", state: "TX", start_date: "2026-05-09" },
    {
      id: "x-1",
      name: "FARMERS MARKET",
      city: "CLINTON TWP",
      state: "MI",
      start_date: "2026-08-01",
    },
    {
      id: "x-1",
      name: "Different",
      city: "Elsewhere",
      start_date: "2026-09-01",
    },
  ]);
  assert.deepEqual(
    distinct.after.map((r) => r.source_record_id),
    distinct.before,
  );
});

test("identical rows are not occurrences, and prose dates give only a date or year", async () => {
  const identical = await ids([market("2026-05-09"), market("2026-05-09")]);
  assert.deepEqual(
    identical.after.map((r) => r.source_record_id),
    identical.before,
  );
  const fair = (dates: string) => ({
    name: "Garden Festival",
    city: "Chaumont",
    country: "France",
    dates,
  });
  const a = await ids([
    fair("Through October 2026"),
    fair("April to October 2027"),
  ]);
  assert.deepEqual(
    a.after.map((r) => r.identity_inputs?.edition),
    ["2026", "2027"],
  );
  const b = await ids([
    fair("Until October 2026"),
    fair("From April to October 2027"),
  ]);
  assert.deepEqual(
    b.after.map((r) => r.source_record_id),
    a.after.map((r) => r.source_record_id),
  );
  const iso = await ids([
    market("2026-06-26T00:00:00.000Z"),
    market("2026-07-03T00:00:00.000Z"),
  ]);
  assert.deepEqual(
    iso.after.map((r) => r.identity_inputs?.edition),
    ["2026-06-26", "2026-07-03"],
  );
});
