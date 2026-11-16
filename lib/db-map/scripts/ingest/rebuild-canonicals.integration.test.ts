/**
 * A matcher or canonical-builder change is repaired by rebuilding the matching layer, not by
 * re-ingesting sources. Runs against the isolated location-assessment test database only.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg, { type Pool } from "pg";
import { runMatch } from "./match.js";
import { parseRebuildArgs, rebuildCanonicals, rebuildPlan } from "./rebuild-canonicals.js";
import { assertNoOutdatedSources, assertSourceCurrent, stalenessBySource } from "./staleness.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import { allNormalizationProfileVersions } from "./normalize/profiles.js";
import { deriveForwardPrecision } from "../../lib/ingestion/geocode-precision.js";
import {
  LOCATION_GEOCODER_VERSION,
  LOCATION_QUERY_VERSION,
  LOCATION_VERSION,
} from "./location.js";
import { recordLocations, writeRecordLocations } from "./record-locations.js";

const connection = process.env.MAP_LOCATION_ASSESSMENT_TEST_URL;
const SOURCE = "rebuild_fixture";
test(
  "an older matcher or builder is repaired by rebuilding canonicals; outdated records still need re-ingesting",
  { skip: !connection },
  async () => {
    const url = new URL(connection!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/map_location_assessment_test");
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.FIREWORKS_API_KEY;
    // Stage code owns its transactions; savepoints keep the whole fixture reversible.
    const tx = {
      query: (sql: string, ...args: any[]) =>
        client.query(
          sql === "BEGIN"
            ? "SAVEPOINT stage_fixture"
            : sql === "COMMIT"
              ? "RELEASE SAVEPOINT stage_fixture"
              : sql === "ROLLBACK"
                ? "ROLLBACK TO SAVEPOINT stage_fixture"
                : sql,
          ...(args as [any]),
        ),
      release() {},
    };
    const db = {
      query: client.query.bind(client),
      connect: async () => tx,
    } as unknown as Pool;
    const token = randomUUID();
    const staleness = async () => (await stalenessBySource(db, SOURCE))[0]!;
    const canonicalOf = async (id: string) =>
      (await client.query("SELECT canonical_poi_id FROM research_pois WHERE id=$1", [id]))
        .rows[0].canonical_poi_id as string | null;
    try {
      await client.query("BEGIN");
      // Only this fixture may be linked, so the database-wide rebuild is fully observable.
      assert.equal((await rebuildPlan(db)).linked, 0, "the isolated database must start empty");
      const source = (
        await client.query(
          "INSERT INTO research_sources(slug,name) VALUES($1,'Rebuild fixture') RETURNING id",
          [SOURCE],
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO canonical_categories(slug,display_name,is_active) VALUES('campground','Campground',true) ON CONFLICT(slug) DO UPDATE SET is_active=true",
      );
      async function seed(name: string, lat: number, website: string) {
        const id = randomUUID(),
          observation = randomUUID(),
          normalization = randomUUID(),
          geocode = randomUUID(),
          lng = -97;
        const point = {
          lat,
          lng,
          kind: "source",
          origin: "source_coordinates",
          precision: "point",
          label: null,
          query: null,
        };
        const validation = {
          version: LOCATION_VERSION,
          fields: { country_code: "US", city: "Austin", region: null, address: null },
          normalization_id: normalization,
          point: { lat, lng },
          coordinate_evidence: {
            source_coordinates: point,
            inferred_coordinates: {
              ...point,
              kind: "inferred",
              origin: "listed_address_geocode",
              query: "Venue, Austin, US",
              precision_evidence: deriveForwardPrecision({}),
            },
          },
          forward: {
            query_version: LOCATION_QUERY_VERSION,
            country_filter: "US",
            result: { ...point, country_code: "US" },
          },
          listed: { country_code: "US", city: "Austin" },
          reverse: null,
          warnings: [],
        };
        await client.query(
          `INSERT INTO research_pois(id,source_id,source_record_id,name,name_normalized,raw,lat,lng,coordinate_source,coordinate_precision,
        category_slugs,is_poi,normalization_state,country_code,city,website,attributes)
        VALUES($1::uuid,$2,$1::text,$3,$3,'{}',$4,$5,'source','point',ARRAY['campground'],true,'active','US','Austin',$6,$7)`,
          [id, source, name, lat, lng, website, { location_enrichment: validation }],
        );
        await client.query(
          "INSERT INTO research_poi_observations(id,research_poi_id,raw_content_hash,raw,captured) VALUES($1::uuid,$2,$1::text,'{}',$3)",
          [observation, id, { name, lat, lng, city: "Austin", country_code: "US" }],
        );
        await client.query(
          `INSERT INTO research_poi_normalizations(id,research_poi_id,observation_id,input_hash,normalizer_version,profile_version,status,is_poi)
        VALUES($1::uuid,$2,$3,$1::text,$4,$5,'accepted',true)`,
          [normalization, id, observation, PIPELINE_VERSIONS.normalizer, allNormalizationProfileVersions()[0]],
        );
        await client.query(
          `INSERT INTO research_poi_geocodes(id,normalization_id,input_hash,provider,provider_version,lat,lng,precision,status,validation)
        VALUES($1::uuid,$2,$1::text,'fixture',$3,$4,$5,'point','resolved',$6)`,
          [geocode, normalization, LOCATION_GEOCODER_VERSION, lat, lng, validation],
        );
        await writeRecordLocations(
          client as never,
          { research_poi_id: id, geocode_id: geocode, normalization_id: normalization },
          recordLocations({
            source: validation.coordinate_evidence.source_coordinates,
            inferred: validation.coordinate_evidence.inferred_coordinates,
            basis: "address",
            fallbackFrom: null,
            rejected: null,
          }),
        );
        await client.query(
          "UPDATE research_pois SET active_observation_id=$2,active_normalization_id=$3,active_geocode_id=$4 WHERE id=$1",
          [id, observation, normalization, geocode],
        );
        return { id, normalization };
      }
      const match = (id: string) =>
        runMatch(
          db,
          {
            recordId: id,
            limit: 1,
            dryRun: false,
            noLlm: true,
            recluster: false,
            gcOrphans: false,
            consolidate: false,
            consolidateOnly: false,
            tHigh: 0.9,
            tLow: 0.3,
          },
          { requested: false, count: 0 },
        );
      globalThis.fetch = async () => {
        throw new Error("fixture provider outage");
      };
      // An anchor and a nearby listing only a model could merge; without one they stay apart.
      const anchor = await seed("Pine Lake Campground", 30, "https://pinelake.example/");
      const second = await seed("Pine Lake Campground Resort", 30.0002, "https://resort.example/");
      await match(anchor.id);
      await match(second.id);
      const before = [await canonicalOf(anchor.id), await canonicalOf(second.id)];
      assert.ok(before[0] && before[1]);
      assert.deepEqual(
        [(await staleness()).outdated, (await staleness()).records],
        [0, 2],
        "freshly matched records are current",
      );
      await assertSourceCurrent(db, SOURCE);
      // A manually curated POI has no research record behind it.
      const manual = (
        await client.query(
          `INSERT INTO canonical_pois(name,lng,lat,status,attributes,field_provenance,popularity,origin)
           VALUES('Curated lookout',-97.5,30.5,'published','{}','{}',1,'manual') RETURNING id`,
        )
      ).rows[0].id;
      const decisionsBefore = (
        await client.query(
          "SELECT count(*)::int AS n FROM research_match_decisions d JOIN research_pois rp ON rp.id=d.research_id WHERE rp.source_id=$1",
          [source],
        )
      ).rows[0].n;
      assert.equal(decisionsBefore, 2);

      // 1. Only the matcher is older: the remedy is a rebuild, not a re-ingest.
      await client.query(
        "UPDATE research_canonical_memberships SET matcher_version='matcher-old' WHERE research_poi_id=$1",
        [anchor.id],
      );
      let row = await staleness();
      assert.deepEqual([row.outdated, row.reingest, row.rebuild, row.matcher], [1, 0, 1, 1]);
      await assert.rejects(assertSourceCurrent(db, SOURCE), (error: any) => {
        assert.equal(error.code, "outdated_canonicals");
        assert.match(error.message, /ingest:rebuild-canonicals/);
        assert.doesNotMatch(error.message, /ingest:clean/);
        return true;
      });

      // Matching is database-wide: another source's run is refused too, with the same remedy.
      await assert.rejects(
        assertSourceCurrent(db, "some_other_source"),
        (error: any) => error.code === "outdated_canonicals",
      );

      // 2. A record that is itself outdated still means re-ingest, and blocks a rebuild.
      await client.query(
        "UPDATE research_poi_normalizations SET normalizer_version='hybrid-old' WHERE id=$1",
        [second.normalization],
      );
      row = await staleness();
      assert.deepEqual([row.reingest, row.rebuild], [1, 1]);
      await assert.rejects(assertSourceCurrent(db, SOURCE), (error: any) => {
        assert.equal(error.code, "outdated_data");
        assert.match(error.message, /ingest:clean/);
        return true;
      });
      await client.query(
        "UPDATE research_poi_normalizations SET normalizer_version=$2 WHERE id=$1",
        [second.normalization, PIPELINE_VERSIONS.normalizer],
      );

      // 3. A rebuild needs owned maintenance.
      await assert.rejects(
        rebuildCanonicals(db, { maintenanceToken: token, noLlm: true }),
        /Owned, quiescent maintenance/,
      );
      await client.query(
        "UPDATE research_ingest_control SET maintenance=true, maintenance_token=$1 WHERE singleton",
        [token],
      );
      await assert.rejects(
        rebuildCanonicals(db, { maintenanceToken: randomUUID(), noLlm: true }),
        /Owned, quiescent maintenance/,
      );
      assert.deepEqual([await canonicalOf(anchor.id), await canonicalOf(second.id)], before);
      // With maintenance owned, an outdated record still blocks the rebuild (checked under
      // the lock) and nothing is reset.
      await client.query(
        "UPDATE research_poi_normalizations SET normalizer_version='hybrid-old' WHERE id=$1",
        [second.normalization],
      );
      // A source that needs re-ingesting does not hide its outdated memberships from others.
      await assert.rejects(assertSourceCurrent(db, "some_other_source"), (error: any) => {
        assert.equal(error.code, "outdated_canonicals");
        assert.match(error.message, /First remove the outdated records of rebuild_fixture/);
        assert.match(error.message, /only then import rebuild_fixture again/);
        return true;
      });
      await assert.rejects(
        assertNoOutdatedSources(db, "some_other_source"),
        (error: any) => error.code === "outdated_canonicals",
      );
      await assert.rejects(
        rebuildCanonicals(db, { maintenanceToken: token, noLlm: true }),
        (error: any) => error.code === "outdated_data",
      );
      await client.query(
        "UPDATE research_poi_normalizations SET normalizer_version=$2 WHERE id=$1",
        [second.normalization, PIPELINE_VERSIONS.normalizer],
      );
      assert.deepEqual([await canonicalOf(anchor.id), await canonicalOf(second.id)], before);

      // 4. With a model outage the rebuild stops; it never records "different place" instead.
      process.env.FIREWORKS_API_KEY = "fixture";
      await assert.rejects(
        rebuildCanonicals(db, { maintenanceToken: token, noLlm: false }),
        /fixture provider outage|Network|fetch/i,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM research_match_decisions d JOIN research_pois rp ON rp.id=d.research_id WHERE rp.source_id=$1 AND d.signals->>'reason'='llm_error'",
            [source],
          )
        ).rows[0].n,
        0,
      );

      // The stopped rebuild matched one record (whichever came first) and left the other
      // unlinked. --continue matches only what is left, resets nothing, and is just as
      // strict about model failures.
      const partial = [await canonicalOf(anchor.id), await canonicalOf(second.id)];
      assert.equal(partial.filter(Boolean).length, 1);
      assert.equal((await rebuildPlan(db)).unlinked, 1);
      await assert.rejects(
        rebuildCanonicals(db, { maintenanceToken: token, noLlm: false, resume: true }),
        /fixture provider outage|Network|fetch/i,
      );
      // Had the matcher changed again meanwhile, continuing would keep an outdated link.
      await client.query(
        "UPDATE research_canonical_memberships SET matcher_version='matcher-old' WHERE active",
      );
      await assert.rejects(
        rebuildCanonicals(db, { maintenanceToken: token, noLlm: true, resume: true }),
        (error: any) => error.code === "outdated_canonicals" && /full rebuild/.test(error.message),
      );
      await client.query(
        "UPDATE research_canonical_memberships SET matcher_version=$1 WHERE active",
        [PIPELINE_VERSIONS.matcher],
      );
      const continued = await rebuildCanonicals(db, {
        maintenanceToken: token,
        noLlm: true,
        resume: true,
      });
      assert.equal(continued.stats.processed, 1);
      const resumed = [await canonicalOf(anchor.id), await canonicalOf(second.id)];
      assert.ok(resumed[0] && resumed[1]);
      assert.ok(
        partial.every((id, i) => !id || id === resumed[i]),
        "a continue resets nothing",
      );

      // 5. The rebuild matches every record again with the current matcher and builder.
      const { stats } = await rebuildCanonicals(db, { maintenanceToken: token, noLlm: true });
      assert.equal(stats.processed, 2);
      const after = [await canonicalOf(anchor.id), await canonicalOf(second.id)];
      assert.ok(after[0] && after[1]);
      assert.ok(!before.includes(after[0]) && !before.includes(after[1]), "canonicals are new");
      row = await staleness();
      assert.deepEqual([row.outdated, row.reingest, row.rebuild], [0, 0, 0]);
      await assertSourceCurrent(db, SOURCE);
      const versions = await client.query(
        `SELECT m.matcher_version, b.builder_version FROM research_canonical_memberships m
         JOIN canonical_pois c ON c.id=m.canonical_poi_id JOIN canonical_poi_builds b ON b.id=c.active_build_id
         JOIN research_pois rp ON rp.id=m.research_poi_id WHERE rp.source_id=$1 AND m.active`,
        [source],
      );
      assert.equal(versions.rowCount, 2);
      for (const v of versions.rows)
        assert.deepEqual(
          [v.matcher_version, v.builder_version],
          [PIPELINE_VERSIONS.matcher, PIPELINE_VERSIONS.canonicalBuilder],
        );
      // Manual POIs survive, and earlier decisions remain as history.
      assert.equal(
        (await client.query("SELECT status FROM canonical_pois WHERE id=$1", [manual])).rows[0]
          ?.status,
        "published",
      );
      assert.ok(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM research_match_decisions d JOIN research_pois rp ON rp.id=d.research_id WHERE rp.source_id=$1",
            [source],
          )
        ).rows[0].n > decisionsBefore,
      );
      // The records themselves were not touched.
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM research_pois WHERE source_id=$1 AND active_normalization_id IS NOT NULL AND active_geocode_id IS NOT NULL",
            [source],
          )
        ).rows[0].n,
        2,
      );
      assert.ok(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM research_ingest_control_events WHERE action='rebuild_canonicals'",
          )
        ).rows[0].n >= 1,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalKey === undefined) delete process.env.FIREWORKS_API_KEY;
      else process.env.FIREWORKS_API_KEY = originalKey;
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end();
    }
  },
);

test("a mistyped flag is refused, never read as a full rebuild", () => {
  assert.deepEqual(parseRebuildArgs(["--maintenance-token", "t", "--continue", "--consolidate"]), {
    dryRun: false,
    resume: true,
    consolidate: true,
    noLlm: false,
    token: "t",
  });
  for (const bad of [["--contiune"], ["--maintenance-token"], ["--maintenance-token", "--continue"], ["extra"]])
    assert.throws(() => parseRebuildArgs(bad), /Unknown argument|needs a value/);
});
