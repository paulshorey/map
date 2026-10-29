import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import pg, { type Pool, type PoolClient } from "pg";
import {
  acceptedLocationSql,
  assessLocationRecord,
  ensureLocationAssessment,
  locationReviewSql,
} from "../../sql/location-assessments.js";
import { listPoisGeoJson, getPoiById } from "../../sql/pois.js";
import { seedTasks, RECORD_STAGES } from "../../sql/ingestion-tasks.js";
import { pendingStageItems, prepareStageQueue } from "./work-queue.js";
import { rebuildCanonicalPoi } from "./merge.js";
import { runMatch } from "./match.js";
import { collapseDuplicateCanonicals } from "./match/canonicals.js";
import { verifyLineage } from "./verify.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import { deriveForwardPrecision } from "../../lib/ingestion/geocode-precision.js";
import { runGeocode, listedQuery, forwardCacheKey } from "./geocode.js";
import {
  LOCATION_GEOCODER_VERSION,
  LOCATION_QUERY_VERSION,
  LOCATION_VERSION,
} from "./location.js";
import { withAttemptContext, type Execution } from "./execution.js";

const connection = process.env.MAP_LOCATION_ASSESSMENT_TEST_URL;
test(
  "real artifact, matching, publication, API and resume gates (isolated PostgreSQL)",
  { skip: !connection },
  async () => {
    const url = new URL(connection!);
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
    assert.equal(url.pathname, "/map_location_assessment_test");
    assert.equal(url.search, "");
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("Providers must remain idle in location regression");
    };
    // Stage APIs own transactions; savepoints keep the whole fixture reversible.
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
    const asClient = client as unknown as PoolClient;
    const matchOptions = (id: string) => ({
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
    });
    try {
      await client.query("BEGIN");
      const source = (
        await client.query(
          "INSERT INTO research_sources(slug,name) VALUES('assessment_fixture','Assessment fixture') RETURNING id",
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO canonical_categories(slug,display_name,is_active) VALUES('campground','Campground',true) ON CONFLICT(slug) DO UPDATE SET is_active=true",
      );
      async function seed(
        name: string,
        lat: number,
        lng: number,
        kind: "both" | "equal" | "inferred" | "legacy" = "both",
      ) {
        const id = randomUUID(),
          observation = randomUUID(),
          normalization = randomUUID(),
          geocode = randomUUID();
        const s = {
          lat,
          lng,
          kind: "source",
          origin: "source_coordinates",
          precision: "point",
          label: null,
          query: null,
        };
        const i = {
          ...s,
          lat: kind === "equal" ? lat : lat + 0.0001,
          kind: "inferred",
          origin: "listed_address_geocode",
          query: "Venue, Austin, US",
          precision_evidence: deriveForwardPrecision({}),
        };
        const point = kind === "inferred" ? { lat: i.lat, lng } : { lat, lng };
        const validation = {
          version: LOCATION_VERSION,
          fields: {
            country_code: "US",
            city: "Austin",
            region: null,
            address: null,
          },
          normalization_id: normalization,
          point,
          coordinate_evidence: {
            source_coordinates: kind === "both" || kind === "equal" ? s : null,
            inferred_coordinates: kind === "legacy" ? null : i,
          },
          forward: {
            query_version: LOCATION_QUERY_VERSION,
            country_filter: "US",
            result: { ...i, country_code: "US" },
          },
          listed: { country_code: "US", city: "Austin" },
          reverse:
            kind === "inferred"
              ? { country_code: "US", city: "Austin", distance_m: 5 }
              : null,
          warnings: [],
        };
        await client.query(
          `INSERT INTO research_pois(id,source_id,source_record_id,name,name_normalized,raw,lat,lng,coordinate_source,coordinate_precision,
        category_slugs,is_poi,normalization_state,country_code,city,attributes) VALUES($1::uuid,$2,$1::text,$3,$3,'{}',$4,$5,$6,'point',ARRAY['campground'],true,'active','US','Austin',$7)`,
          [
            id,
            source,
            name,
            point.lat,
            point.lng,
            kind === "inferred" ? "geocode" : "source",
            { location_enrichment: validation },
          ],
        );
        await client.query(
          "INSERT INTO research_poi_observations(id,research_poi_id,raw_content_hash,raw,captured) VALUES($1::uuid,$2,$1::text,'{}',$3)",
          [
            observation,
            id,
            {
              name,
              lat: kind === "inferred" ? null : lat,
              lng: kind === "inferred" ? null : lng,
              city: "Austin",
              country_code: "US",
            },
          ],
        );
        await client.query(
          `INSERT INTO research_poi_normalizations(id,research_poi_id,observation_id,input_hash,normalizer_version,status,is_poi)
        VALUES($1::uuid,$2,$3,$1::text,'fixture','accepted',true)`,
          [normalization, id, observation],
        );
        await client.query(
          `INSERT INTO research_poi_geocodes(id,normalization_id,input_hash,provider,provider_version,lat,lng,precision,status,validation)
        VALUES($1::uuid,$2,$1::text,'fixture',$3,$4,$5,'point','resolved',$6)`,
          [
            geocode,
            normalization,
            kind === "legacy"
              ? "locationiq-location-v2"
              : LOCATION_GEOCODER_VERSION,
            point.lat,
            point.lng,
            validation,
          ],
        );
        await client.query(
          "UPDATE research_pois SET active_observation_id=$2,active_normalization_id=$3,active_geocode_id=$4 WHERE id=$1",
          [id, observation, normalization, geocode],
        );
        return { id, observation, normalization, geocode, validation };
      }
      const f = await seed("Accepted campground", 30, -97);
      const first = await ensureLocationAssessment(asClient, f.id);
      assert.equal(first.status, "accepted");
      await client.query("SAVEPOINT immutable_assessment");
      await assert.rejects(
        client.query(
          "UPDATE research_poi_location_assessments SET status='needs_review',accepted_kind=NULL,accepted_point=NULL WHERE id=$1",
          [first.id],
        ),
        /immutable/,
      );
      await client.query("ROLLBACK TO SAVEPOINT immutable_assessment");
      assert.equal(
        (await ensureLocationAssessment(asClient, f.id)).id,
        first.id,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int n FROM research_poi_location_assessments WHERE research_poi_id=$1",
            [f.id],
          )
        ).rows[0].n,
        1,
      );
      const matched = await runMatch(db, matchOptions(f.id), {
        requested: false,
        count: 0,
      });
      assert.equal(matched.created, 1);
      let cp = (
        await client.query(
          "SELECT cp.* FROM canonical_pois cp JOIN research_pois rp ON rp.canonical_poi_id=cp.id WHERE rp.id=$1",
          [f.id],
        )
      ).rows[0];
      assert.equal(cp.status, "published");
      const build = cp.active_build_id;
      const input = (
        await client.query(
          "SELECT * FROM canonical_poi_build_inputs WHERE build_id=$1",
          [build],
        )
      ).rows[0];
      assert.equal(input.location_assessment_id, first.id);
      assert.equal(
        (
          await client.query(
            "SELECT builder_version FROM canonical_poi_builds WHERE id=$1",
            [build],
          )
        ).rows[0].builder_version,
        PIPELINE_VERSIONS.canonicalBuilder,
      );
      assert.equal((await getPoiById(db, cp.id)).locations.length, 2);
      assert.deepEqual(
        (await getPoiById(db, cp.id)).coordinate_evidence.inferred_coordinates
          ?.precision_evidence,
        f.validation.coordinate_evidence.inferred_coordinates
          ?.precision_evidence,
      );
      const world = (await listPoisGeoJson(db, {
        west: -180,
        east: 180,
        south: -90,
        north: 90,
        category: null,
        limit: 10,
        isWorldView: true,
      })) as any;
      assert.equal(
        world.features.filter((x: any) => x.properties.id === cp.id).length,
        2,
      );

      // Cross-country members stay published. The assessment records the difference.
      const foreign = await seed("Conflicting country", 30.0002, -97);
      const foreignValidation = structuredClone(foreign.validation);
      foreignValidation.fields.country_code = "CA";
      foreignValidation.listed.country_code = "CA";
      foreignValidation.forward.result.country_code = "CA";
      foreignValidation.forward.country_filter = "CA";
      await client.query(
        "UPDATE research_poi_observations SET captured=jsonb_set(captured,'{country_code}','\"CA\"') WHERE id=$1",
        [foreign.observation],
      );
      await client.query(
        "UPDATE research_poi_geocodes SET validation=$2 WHERE id=$1",
        [foreign.geocode, foreignValidation],
      );
      await client.query(
        "UPDATE research_pois SET country_code='CA',canonical_poi_id=$2,attributes=jsonb_build_object('location_enrichment',$3::jsonb) WHERE id=$1",
        [foreign.id, cp.id, foreignValidation],
      );
      await client.query(
        "INSERT INTO research_canonical_memberships(research_poi_id,normalization_id,canonical_poi_id,matcher_version) VALUES($1,$2,$3,$4)",
        [foreign.id, foreign.normalization, cp.id, PIPELINE_VERSIONS.matcher],
      );
      assert.equal(
        (await ensureLocationAssessment(asClient, foreign.id)).status,
        "accepted",
      );
      assert.equal(
        (await rebuildCanonicalPoi(asClient, cp.id, { noLlm: true })).published,
        true,
      );
      assert.equal(
        (
          await client.query("SELECT status FROM canonical_pois WHERE id=$1", [
            cp.id,
          ])
        ).rows[0].status,
        "published",
      );
      await client.query(
        "DELETE FROM research_canonical_memberships WHERE research_poi_id=$1",
        [foreign.id],
      );
      await client.query("DELETE FROM research_pois WHERE id=$1", [foreign.id]);
      assert.equal(
        (await rebuildCanonicalPoi(asClient, cp.id, { noLlm: true })).published,
        true,
      );
      assert.equal(
        (
          await client.query(
            "SELECT active_build_id FROM canonical_pois WHERE id=$1",
            [cp.id],
          )
        ).rows[0].active_build_id,
        build,
      );
      await client.query(
        "DELETE FROM canonical_poi_builds WHERE canonical_poi_id=$1 AND id<>$2",
        [cp.id, build],
      );

      const inferred = await seed("Inferred campground", 35, -100, "inferred");
      assert.equal(
        (await ensureLocationAssessment(asClient, inferred.id)).accepted_kind,
        "inferred",
      );
      assert.equal(
        (
          await runMatch(db, matchOptions(inferred.id), {
            requested: false,
            count: 0,
          })
        ).created,
        1,
      );
      const inferredCanonical = (
        await client.query(
          "SELECT canonical_poi_id FROM research_pois WHERE id=$1",
          [inferred.id],
        )
      ).rows[0].canonical_poi_id;
      const detail = await getPoiById(db, inferredCanonical);
      assert.equal(detail.coordinate_evidence.source_coordinates, null);
      assert.equal(detail.locations[0].kind, "inferred");
      assert.equal(detail.lat, inferred.validation.point.lat);

      const equal = await seed("Equal evidence", 31, -90, "equal");
      assert.equal(
        (
          await runMatch(db, matchOptions(equal.id), {
            requested: false,
            count: 0,
          })
        ).created,
        1,
      );
      const equalId = (
        await client.query(
          "SELECT canonical_poi_id FROM research_pois WHERE id=$1",
          [equal.id],
        )
      ).rows[0].canonical_poi_id;
      const equalDetail = await getPoiById(db, equalId);
      assert.equal(equalDetail.locations.length, 1);
      assert.ok(equalDetail.coordinate_evidence.source_coordinates);
      assert.ok(equalDetail.coordinate_evidence.inferred_coordinates);
      assert.equal(
        equalDetail.coordinate_evidence.inferred_coordinates.precision_evidence
          ?.derivation,
        "fallback",
      );

      // Exercise real cache -> geocode artifact -> matcher -> API SQL with network forbidden.
      await client.query("SAVEPOINT precision_cache_fixture");
      const cached = await seed(
        "Cached provider evidence",
        30.3,
        -97,
        "legacy",
      );
      const cachedRow = (
        await client.query(
          `SELECT rp.*,o.captured FROM research_pois rp
        JOIN research_poi_observations o ON o.id=rp.active_observation_id WHERE rp.id=$1`,
          [cached.id],
        )
      ).rows[0];
      const query = listedQuery(cachedRow, cachedRow.captured, new Set())!;
      const raw = {
        lat: "40",
        lon: "-100",
        display_name: "Fixture result",
        boundingbox: ["39", "41", "-101", "-99"],
        // Real addressdetails name the city; an unnamed far result would need a city lookup.
        address: { city: "Austin", state: "Texas", country_code: "us" },
      };
      const hit = {
        lat: 40,
        lng: -100,
        precision: "point",
        provider: "locationiq",
        label: raw.display_name,
        precision_evidence: deriveForwardPrecision(raw),
        raw_response: raw,
      };
      const key = forwardCacheKey(query.norm, "US");
      await client.query(
        `INSERT INTO research_geocode_cache(query_norm,lat,lng,precision,provider,payload)
        VALUES($1,40,-100,'point','locationiq',$2::jsonb)`,
        [key, JSON.stringify({ hit })],
      );
      await client.query(
        `INSERT INTO research_geocode_cache(query_norm,lat,lng,precision,provider,payload)
        VALUES($1,30.3,-97,'point','locationiq','{"hit":null}'::jsonb)`,
        [`location-v2:reverse:30.3:-97`],
      );
      const geocoded = await runGeocode(db, {
        recordId: cached.id,
        limit: 1,
        geocodeLimit: 0,
        throttleMs: 0,
        dryRun: false,
      });
      assert.equal(geocoded.apiCalls, 0);
      assert.equal(geocoded.cacheHits, 2);
      const stored = (
        await client.query(
          `SELECT g.validation FROM research_pois rp
        JOIN research_poi_geocodes g ON g.id=rp.active_geocode_id WHERE rp.id=$1`,
          [cached.id],
        )
      ).rows[0].validation;
      assert.deepEqual(stored.forward.result.raw_response, raw);
      assert.deepEqual(
        stored.coordinate_evidence.inferred_coordinates.precision_evidence,
        hit.precision_evidence,
      );
      assert.equal(
        (
          await runMatch(db, matchOptions(cached.id), {
            requested: false,
            count: 0,
          })
        ).created,
        1,
      );
      const cachedCanonical = (
        await client.query(
          "SELECT canonical_poi_id FROM research_pois WHERE id=$1",
          [cached.id],
        )
      ).rows[0].canonical_poi_id;
      const cachedDetail = await getPoiById(db, cachedCanonical);
      assert.equal(cachedDetail.locations.length, 2);
      assert.deepEqual(
        cachedDetail.coordinate_evidence.inferred_coordinates
          .precision_evidence,
        hit.precision_evidence,
      );
      assert.equal(
        (
          await client.query(
            "SELECT status FROM research_poi_location_assessments WHERE research_poi_id=$1",
            [cached.id],
          )
        ).rows[0].status,
        "needs_review",
      );
      assert.deepEqual(
        (
          await client.query(
            "SELECT payload FROM research_geocode_cache WHERE query_norm=$1",
            [key],
          )
        ).rows[0].payload,
        { hit },
      );
      assert.equal(await verifyLineage(db), 0);
      await client.query("ROLLBACK TO SAVEPOINT precision_cache_fixture");

      const legacy = await seed("Unassessed legacy", 40, -110, "legacy");

      // A far inferred point is advisory. Both markers publish.
      const changedGeo = randomUUID(),
        conflict = structuredClone(f.validation);
      conflict.coordinate_evidence.inferred_coordinates!.lat = 40;
      conflict.forward.result.lat = 40;
      await client.query(
        `INSERT INTO research_poi_geocodes(id,normalization_id,input_hash,provider,provider_version,lat,lng,precision,status,validation)
      VALUES($1::uuid,$2,$1::text,'fixture',$3,30,-97,'point','resolved',$4)`,
        [changedGeo, f.normalization, LOCATION_GEOCODER_VERSION, conflict],
      );
      await client.query(
        "UPDATE research_pois SET active_geocode_id=$2,attributes=jsonb_build_object('location_enrichment',$3::jsonb) WHERE id=$1",
        [f.id, changedGeo, conflict],
      );
      assert.equal(
        (
          await client.query(
            `SELECT ${acceptedLocationSql()} ready FROM research_pois rp WHERE rp.id=$1`,
            [f.id],
          )
        ).rows[0].ready,
        false,
      );
      const second = await ensureLocationAssessment(asClient, f.id);
      assert.notEqual(second.id, first.id);
      assert.equal(second.status, "needs_review");
      assert.ok(Number(second.evidence.distance_m) > 250);
      assert.equal(
        (await rebuildCanonicalPoi(asClient, cp.id, { noLlm: true })).published,
        true,
      );
      const conflictDetail = await getPoiById(db, cp.id);
      assert.equal(conflictDetail.locations.length, 2);
      assert.ok(conflictDetail.coordinate_evidence.source_coordinates);
      assert.ok(conflictDetail.coordinate_evidence.inferred_coordinates);
      const conflictBuild = (
        await client.query(
          "SELECT active_build_id FROM canonical_pois WHERE id=$1",
          [cp.id],
        )
      ).rows[0].active_build_id;
      assert.notEqual(conflictBuild, build);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int n FROM canonical_poi_builds WHERE canonical_poi_id=$1",
            [cp.id],
          )
        ).rows[0].n,
        2,
      );

      // Exercise the actual scheduler/cache queries on a selected frozen cohort.
      const file = (
        await client.query(
          "INSERT INTO research_source_files(source_id,logical_path,category_slug,format,extractor_version) VALUES($1,'data/poi/test.json','campground','json','fixture') RETURNING id",
          [source],
        )
      ).rows[0].id;
      const version = (
        await client.query(
          "INSERT INTO research_source_file_versions(source_file_id,file_sha256,byte_size,extractor_version) VALUES($1,'fixture',1,'fixture') RETURNING id",
          [file],
        )
      ).rows[0].id;
      const run = (
        await client.query(
          "INSERT INTO research_ingest_runs(source_file_version_id,source_id,category_slug) VALUES($1,$2,'campground') RETURNING id",
          [version, source],
        )
      ).rows[0].id;
      const execution = (
        await client.query(
          "INSERT INTO research_ingest_executions(run_id,host,pid,options) VALUES($1,'fixture',1,'{}') RETURNING id",
          [run],
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO research_ingest_run_items(run_id,source_record_id,source_ordinal,research_poi_id,observation_id) VALUES($1,$2::text,0,$2::uuid,$3)",
        [run, f.id, f.observation],
      );
      const output = {
        status: "succeeded",
        canonical_id: cp.id,
        build_id: build,
        normalization_id: f.normalization,
        geocode_id: changedGeo,
      };
      for (const [rank, stage] of RECORD_STAGES.entries()) {
        await client.query(
          "INSERT INTO research_ingest_tasks(run_id,source_record_id,stage,rank,state,output) VALUES($1,$2,$3,$4,'succeeded',$5)",
          [run, f.id, stage, rank, output],
        );
        await client.query(
          "INSERT INTO research_ingest_attempts(run_id,execution_id,stage,target_key,status,output) VALUES($1,$2,$3,$4,'succeeded',$5)",
          [run, execution, stage, f.id, output],
        );
      }
      await seedTasks(db, run, execution);
      let reused = 0;
      const ex = {
        runId: run,
        check() {},
        stopped: false,
        reuseBatch: async (_s: string, values: unknown[]) => {
          reused += values.length;
          return values.length;
        },
      } as unknown as Execution;
      for (const stage of ["match", "canonical", "verify"]) {
        assert.equal((await pendingStageItems(db, run, stage)).length, 1);
        assert.equal(
          (await prepareStageQueue(db, ex, stage, 1, {} as any)).reused,
          1,
        );
      }
      assert.equal(reused, 3);
      // A membership retired by normalization does not erase the previous serving snapshot.
      await client.query(
        "UPDATE research_canonical_memberships SET active=false,retired_at=now(),retirement_reason='normalization_changed' WHERE research_poi_id=$1",
        [f.id],
      );
      await client.query(
        "UPDATE research_pois SET canonical_poi_id=NULL WHERE id=$1",
        [f.id],
      );
      assert.equal(
        (await rebuildCanonicalPoi(asClient, cp.id, { noLlm: true })).reason,
        "location_refresh_pending",
      );
      assert.equal(
        (
          await client.query(
            "SELECT active_build_id FROM canonical_pois WHERE id=$1",
            [cp.id],
          )
        ).rows[0].active_build_id,
        conflictBuild,
      );
      assert.equal(await verifyLineage(db), 0);

      // A completed rematch replaces that held snapshot. Exercise applyDecision,
      // not just the SQL predicate, and keep the later cache fixtures unchanged.
      await client.query("SAVEPOINT completed_rematch");
      await client.query(
        "INSERT INTO research_match_overrides(record_a,record_b,rule) VALUES($1,NULL,'force_different')",
        [f.id],
      );
      assert.equal(
        (await runMatch(db, matchOptions(f.id), { requested: false, count: 0 }))
          .created,
        1,
      );
      const replacement = (
        await client.query(
          "SELECT canonical_poi_id FROM research_pois WHERE id=$1",
          [f.id],
        )
      ).rows[0].canonical_poi_id;
      assert.notEqual(replacement, cp.id);
      assert.equal(
        (
          await client.query("SELECT status FROM canonical_pois WHERE id=$1", [
            replacement,
          ])
        ).rows[0].status,
        "published",
      );
      assert.equal(
        (
          await client.query("SELECT status FROM canonical_pois WHERE id=$1", [
            cp.id,
          ])
        ).rows[0].status,
        "hidden",
      );
      const rematchedMap = (await listPoisGeoJson(db, {
        west: -180,
        east: 180,
        south: -90,
        north: 90,
        category: null,
        limit: 10,
        isWorldView: true,
      })) as any;
      assert.equal(
        rematchedMap.features.filter((x: any) => x.properties.id === cp.id)
          .length,
        0,
      );
      assert.ok(
        rematchedMap.features.some((x: any) => x.properties.id === replacement),
      );
      assert.equal(await verifyLineage(db), 0);
      // The verifier must also detect a stale duplicate if it reappears.
      await client.query(
        "UPDATE canonical_pois SET status='published' WHERE id=$1",
        [cp.id],
      );
      assert.ok((await verifyLineage(db)) > 0);
      await client.query("ROLLBACK TO SAVEPOINT completed_rematch");

      // Return to the immutable original inputs: reuse the same assessment and build without providers.
      await client.query(
        "UPDATE research_pois SET active_geocode_id=$2,canonical_poi_id=$3,attributes=jsonb_build_object('location_enrichment',$4::jsonb) WHERE id=$1",
        [f.id, f.geocode, cp.id, f.validation],
      );
      await client.query(
        "UPDATE research_canonical_memberships SET active=true,retired_at=NULL,retirement_reason=NULL WHERE research_poi_id=$1",
        [f.id],
      );
      assert.equal(
        (await ensureLocationAssessment(asClient, f.id)).id,
        first.id,
      );
      assert.equal(
        (await rebuildCanonicalPoi(asClient, cp.id, { noLlm: true })).published,
        true,
      );
      assert.equal(
        (
          await client.query(
            "SELECT active_build_id FROM canonical_pois WHERE id=$1",
            [cp.id],
          )
        ).rows[0].active_build_id,
        build,
      );
      for (const stage of ["match", "canonical", "verify"])
        assert.equal((await pendingStageItems(db, run, stage)).length, 0);
      await client.query(
        "DELETE FROM research_ingest_attempts WHERE run_id=$1 AND stage IN ('match','canonical','verify')",
        [run],
      );
      for (const stage of ["match", "canonical", "verify"])
        assert.equal(
          (await prepareStageQueue(db, ex, stage, 1, {} as any)).reused,
          1,
        );
      const stalePolicy = (
        await client.query(
          `INSERT INTO research_poi_location_assessments(research_poi_id,observation_id,normalization_id,geocode_id,
      policy_version,input_hash,input_snapshot,status,accepted_kind,accepted_point,reasons,evidence)
      SELECT research_poi_id,observation_id,normalization_id,geocode_id,'old-policy',input_hash,input_snapshot,status,accepted_kind,accepted_point,reasons,evidence
      FROM research_poi_location_assessments WHERE id=$1 RETURNING id`,
          [first.id],
        )
      ).rows[0].id;
      await client.query(
        "UPDATE research_pois SET active_location_assessment_id=$2 WHERE id=$1",
        [f.id, stalePolicy],
      );
      assert.equal(
        (await prepareStageQueue(db, ex, "match", 1, {} as any)).reused,
        0,
      );
      assert.equal(
        (await ensureLocationAssessment(asClient, f.id)).id,
        first.id,
      );

      // A missing assessment pointer does not block consolidation.
      await client.query(
        "UPDATE research_pois SET active_location_assessment_id=NULL WHERE id=$1",
        [inferred.id],
      );
      await collapseDuplicateCanonicals(asClient, cp.id, [inferredCanonical]);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int n FROM canonical_poi_redirects",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int n FROM research_poi_location_assessments WHERE research_poi_id=$1",
            [f.id],
          )
        ).rows[0].n,
        3,
      );
      // Stale geocoder evidence still publishes its usable source point.
      await client.query(
        "INSERT INTO research_ingest_run_items(run_id,source_record_id,source_ordinal,research_poi_id,observation_id) VALUES($1,$2::text,1,$2::uuid,$3)",
        [run, legacy.id, legacy.observation],
      );
      const claim = {
        run_id: run,
        source_record_id: legacy.id,
        research_poi_id: legacy.id,
        observation_id: legacy.observation,
        stage: "match" as const,
        rank: 3,
        claim_token: randomUUID(),
        execution_id: execution,
      };
      const attempt = (
        await client.query(
          "INSERT INTO research_ingest_attempts(run_id,execution_id,stage,target_key,status) VALUES($1,$2,'match',$3,'running') RETURNING id",
          [run, execution, legacy.id],
        )
      ).rows[0].id;
      await client.query(
        "INSERT INTO research_ingest_tasks(run_id,source_record_id,stage,rank,state,claim_token,execution_id) VALUES($1,$2,'match',3,'running',$3,$4)",
        [run, legacy.id, claim.claim_token, execution],
      );
      await withAttemptContext(
        {
          runId: run,
          attemptId: attempt,
          execution: {} as Execution,
          claim,
          stage: "match",
        },
        () =>
          runMatch(db, matchOptions(legacy.id), { requested: false, count: 0 }),
      );
      assert.equal(
        (
          await client.query(
            "SELECT state FROM research_ingest_tasks WHERE run_id=$1 AND source_record_id=$2 AND stage='match'",
            [run, legacy.id],
          )
        ).rows[0].state,
        "succeeded",
      );
      assert.ok(
        (
          await client.query(
            "SELECT canonical_poi_id FROM research_pois WHERE id=$1",
            [legacy.id],
          )
        ).rows[0].canonical_poi_id,
      );
      // Explicit POI cleanup still cascades through the new artifact graph.
      await client.query(
        "UPDATE research_pois SET lat=NULL,lng=NULL,active_geocode_id=NULL WHERE id=$1",
        [legacy.id],
      );
      const unlocated = await assessLocationRecord(db, legacy.id);
      assert.equal(unlocated.status, "unlocated");
      assert.equal(unlocated.accepted_point, null);
      await client.query("DELETE FROM research_pois WHERE id=$1", [legacy.id]);
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int n FROM research_poi_location_assessments WHERE research_poi_id=$1",
            [legacy.id],
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await client.query("ROLLBACK");
      await client.end();
      globalThis.fetch = originalFetch;
    }
  },
);

test(
  "location review flag trusts enrichment only while bound to the active normalization and point",
  { skip: !connection },
  async () => {
    const client = new pg.Client({ connectionString: connection });
    await client.connect();
    try {
      const enrichment = (
        normalization: string,
        point: { lat: number | null; lng: number | null },
        source: string | null,
        inferred: string | null,
      ) =>
        JSON.stringify({
          location_enrichment: {
            version: LOCATION_VERSION,
            normalization_id: normalization,
            point,
            coordinate_evidence: {
              source_coordinates: source && {
                lat: 1,
                lng: 2,
                precision: source,
              },
              inferred_coordinates: inferred && {
                lat: 3,
                lng: 4,
                precision: inferred,
              },
            },
          },
        });
      const current = randomUUID(),
        stale = randomUUID();
      const cases: Array<
        [
          string,
          string,
          number | null,
          number | null,
          string | null,
          string | null,
        ]
      > = [
        // A later normalization cleared the coordinates; the old enrichment must not hide that.
        [
          "stale enrichment, coordinates cleared",
          enrichment(stale, { lat: 1, lng: 2 }, "point", null),
          null,
          null,
          null,
          "missing_location",
        ],
        // The point moved under a stale enrichment; the current coarse column decides.
        [
          "stale point, coarse column",
          enrichment(current, { lat: 1, lng: 2 }, "point", null),
          5,
          6,
          "city",
          "coarse_location_only",
        ],
        [
          "bound point evidence",
          enrichment(current, { lat: 1, lng: 2 }, "point", "country"),
          1,
          2,
          "point",
          null,
        ],
        [
          "bound country-only evidence",
          enrichment(current, { lat: 3, lng: 4 }, null, "country"),
          3,
          4,
          "country",
          "coarse_location_only",
        ],
        [
          "bound, no candidates",
          enrichment(current, { lat: null, lng: null }, null, null),
          null,
          null,
          null,
          "missing_location",
        ],
      ];
      for (const [name, attributes, lat, lng, precision, expected] of cases) {
        const { rows } = await client.query(
          `SELECT ${locationReviewSql("rp")} AS reason
           FROM (SELECT $1::jsonb AS attributes, $2::float8 AS lat, $3::float8 AS lng,
             $4::uuid AS active_normalization_id, $5::text AS coordinate_precision) rp`,
          [attributes, lat, lng, current, precision],
        );
        assert.equal(rows[0].reason, expected, name);
      }
    } finally {
      await client.end();
    }
  },
);
