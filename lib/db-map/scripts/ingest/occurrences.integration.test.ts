/**
 * Repeated occurrences in a capture with no ID field: each gets its own identity, a
 * same-date repeat is dropped, the file completes, and an identity left by an earlier
 * attempt at the same file version is retired. Runs against the isolated
 * location-assessment test database only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import { runOrchestration } from "./orchestrator.js";
import { POI_ROOT } from "./source-file.js";

const connection = process.env.MAP_LOCATION_ASSESSMENT_TEST_URL;
test(
  "occurrences are separated, same-date repeats dropped, and leftovers of a stopped attempt retired",
  { skip: !connection },
  async () => {
    const url = new URL(connection!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/map_location_assessment_test");
    assert.equal(
      process.env.DB_MAP_URL,
      connection,
      "the pipeline must use the test database",
    );
    const db = new pg.Pool({ connectionString: connection, max: 4 });
    const slug = `occurrence_test_${randomUUID().slice(0, 8)}`;
    const dir = await mkdtemp(resolve(POI_ROOT, "occurrence-test-"));
    const file = resolve(dir, `${slug}.json`);
    const market = (start_date: string, booth_fee: number) => ({
      name: "Farmers Market",
      city: "Clinton Township",
      state: "MI",
      country: "US",
      start_date,
      booth_fee,
    });
    await writeFile(
      file,
      JSON.stringify([
        market("2026-05-09", 10),
        market("2026-06-13", 10),
        market("2026-06-13", 25),
        {
          name: "Art Fair",
          city: "Austin",
          state: "TX",
          country: "US",
          start_date: "2026-05-09",
        },
        // Nothing to identify or place this row by: dropped, and the file still completes.
        { name: "Somewhere Festival", start_date: "2026-07-01" },
      ]),
    );
    const options = {
      file,
      category: "art_fair",
      noLlm: true,
      dryRun: false,
      shadow: false,
      retryFailed: false,
      stopAfter: "extract" as const,
    };
    const active = async () =>
      (
        await db.query<{ source_record_id: string; edition: string | null }>(
          `SELECT rp.source_record_id, rp.identity_inputs->>'edition' AS edition
           FROM research_pois rp JOIN research_sources s ON s.id=rp.source_id
           WHERE s.slug=$1 AND rp.retired_at IS NULL ORDER BY 2 NULLS FIRST, 1`,
          [slug],
        )
      ).rows;
    try {
      await runOrchestration(db, options);
      process.exitCode = 0;
      const first = await active();
      assert.deepEqual(
        first.map((row) => row.edition),
        [null, "2026-05-09", "2026-06-13"],
        "two dated markets and the undated-identity art fair",
      );
      const { rows: dropped } = await db.query(
        `SELECT rr.last_error_class FROM research_ingest_run_records rr
         JOIN research_ingest_runs r ON r.id=rr.run_id JOIN research_sources s ON s.id=r.source_id
         WHERE s.slug=$1 AND rr.extract_state='duplicate'`,
        [slug],
      );
      assert.deepEqual(dropped, [
        { last_error_class: "synthetic_identity_repeat" },
      ]);
      const { rows: rejected } = await db.query(
        `SELECT rr.last_error_class FROM research_ingest_run_records rr
         JOIN research_ingest_runs r ON r.id=rr.run_id JOIN research_sources s ON s.id=r.source_id
         WHERE s.slug=$1 AND rr.extract_state='rejected'`,
        [slug],
      );
      assert.deepEqual(rejected, [
        { last_error_class: "missing_source_record_id" },
      ]);
      const { rows: version } = await db.query(
        `SELECT v.status FROM research_source_file_versions v
         JOIN research_ingest_runs r ON r.source_file_version_id=v.id
         JOIN research_sources s ON s.id=r.source_id WHERE s.slug=$1`,
        [slug],
      );
      assert.deepEqual(
        version,
        [{ status: "complete" }],
        "the file's extraction is complete",
      );

      // An earlier attempt at this same file version left an identity the capture no longer
      // produces (the pre-fix base ID). A complete pass retires it.
      const moved = first.find((row) => row.edition === "2026-05-09")!;
      await db.query(
        `UPDATE research_pois SET source_record_id=$2
         WHERE source_record_id=$1 AND source_id=(SELECT id FROM research_sources WHERE slug=$3)`,
        [moved.source_record_id, "leftover-base-id", slug],
      );
      await db.query(
        `UPDATE research_ingest_run_records SET source_record_id=$2
         WHERE source_record_id=$1 AND run_id IN (
           SELECT r.id FROM research_ingest_runs r JOIN research_sources s ON s.id=r.source_id
           WHERE s.slug=$3)`,
        [moved.source_record_id, "leftover-base-id", slug],
      );
      await runOrchestration(db, { ...options, reprocess: "extract" as const });
      process.exitCode = 0;
      const second = await active();
      assert.deepEqual(
        second.map((row) => row.source_record_id).sort(),
        first.map((row) => row.source_record_id).sort(),
        "the leftover identity is retired and the occurrence is back under its own ID",
      );
      const { rows: scope } = await db.query<{
        leftovers: number;
        items: number;
      }>(
        `SELECT count(*) FILTER (WHERE i.source_record_id='leftover-base-id')::int AS leftovers,
                count(*)::int AS items
         FROM research_ingest_run_items i
         WHERE i.run_id=(SELECT r.id FROM research_ingest_runs r JOIN research_sources s ON s.id=r.source_id
                         WHERE s.slug=$1 ORDER BY r.created_at DESC LIMIT 1)`,
        [slug],
      );
      assert.deepEqual(
        scope,
        [{ leftovers: 0, items: 3 }],
        "the run works on what it extracted",
      );
    } finally {
      // The rows stay in the isolated test database under a unique source slug.
      await rm(dir, { recursive: true, force: true });
      await db.end();
    }
  },
);
