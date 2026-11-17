import assert from "node:assert/strict";
import { test } from "node:test";
import { mapGenericRecord, separateOccurrences } from "./generic.js";
import type { RawRecord } from "../types.js";

async function ids(raws: Array<Record<string, unknown>>) {
  const mapped = raws.map((raw) => mapGenericRecord(raw, { sourceSlug: "fixture" })!);
  async function* stream() {
    yield* mapped;
  }
  const out: RawRecord[] = [];
  for await (const record of separateOccurrences(stream(), "fixture")) out.push(record);
  return { before: mapped.map((r) => r.source_record_id), after: out };
}
const market = (start_date: string | undefined, extra: Record<string, unknown> = {}) => ({
  name: "FARMERS MARKET",
  city: "CLINTON TWP",
  state: "MI",
  ...(start_date ? { start_date } : {}),
  ...extra,
});

test("repeated occurrences of one event get their own identity; the first keeps its ID", async () => {
  const { before, after } = await ids([
    market("2026-05-09"),
    market("2026-06-13"),
    market("2026-07-11"),
  ]);
  assert.equal(new Set(before).size, 1, "name and locality alone collide");
  assert.equal(after[0]!.source_record_id, before[0], "the first record is unchanged");
  assert.equal(new Set(after.map((r) => r.source_record_id)).size, 3);
  assert.equal(after[1]!.identity_inputs?.edition, "2026-06-13");
  assert.equal(after[0]!.identity_inputs?.edition ?? null, null);
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
  const undated = await ids([market(undefined, { booth_fee: 10 }), market(undefined, { booth_fee: 20 })]);
  assert.equal(new Set(undated.after.map((r) => r.source_record_id)).size, 1);
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
    { id: "x-1", name: "FARMERS MARKET", city: "CLINTON TWP", state: "MI", start_date: "2026-08-01" },
    { id: "x-1", name: "Different", city: "Elsewhere", start_date: "2026-09-01" },
  ]);
  assert.deepEqual(
    distinct.after.map((r) => r.source_record_id),
    distinct.before,
  );
});
