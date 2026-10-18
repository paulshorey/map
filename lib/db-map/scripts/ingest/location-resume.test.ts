import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  RECORD_STAGES,
  finishTask,
  type TaskClaim,
} from "../../sql/ingestion-tasks.js";
import {
  artifactTransaction,
  withAttemptContext,
  type AttemptResult,
  type Execution,
} from "./execution.js";
import { runRecordScheduler } from "./record-scheduler.js";
import { runGeocode } from "./geocode.js";
import { buildEmbedText } from "./embed.js";

for (const completion of ["succeeded", "reused"] as const) {
  test(`compatible location resume (${completion}) repairs downstream checkpoints in the activation commit`, async () => {
    // Seed-time snapshot: only v1 geocode is stale; every old downstream ID still matches.
    const tasks = RECORD_STAGES.map((stage, rank) => ({
      stage,
      rank,
      state: stage === "geocode" ? "pending" : "succeeded",
      output: {
        status: "succeeded",
        embedding_id: "embedding-old",
        build_id: "build-old",
      } as AttemptResult | null,
    }));
    let embedding: string | null = "embedding-old";
    let geocode = "geocode-v1";
    let build: { id: string; embedding: string | null; geocode: string } = {
      id: "build-old",
      embedding,
      geocode,
    };
    const executions: string[] = [];
    const commits: unknown[] = [];
    const attempts = ["old-successful-attempt"];
    const client = {
      release() {},
      async query(sql: string, args: any[] = []) {
        if (sql === "COMMIT") {
          commits.push({
            embedding,
            geocode,
            states: tasks.map((t) => t.state),
          });
        } else if (sql.startsWith("SELECT t.stage")) {
          return {
            rows: tasks.filter(
              (t) => t.stage === args[2] && t.state === "running",
            ),
          };
        } else if (sql.startsWith("WITH selected")) {
          const selected = tasks.filter(
            (t) =>
              t.stage === args[2] &&
              t.state === "pending" &&
              tasks
                .filter((p) => p.rank < t.rank)
                .every((p) =>
                  ["succeeded", "reused", "skipped"].includes(p.state),
                ),
          );
          for (const t of selected) t.state = "running";
          return {
            rows: selected.map((t) => ({
              ...t,
              run_id: "run",
              source_record_id: "record",
              research_poi_id: "poi",
              observation_id: "observation",
              execution_id: "execution",
              claim_token: args[3],
            })),
          };
        } else if (
          sql.startsWith("UPDATE research_ingest_tasks SET state=$6")
        ) {
          const task = tasks.find((t) => t.stage === args[2])!;
          task.state = args[5];
          task.output = JSON.parse(args[7]);
        } else if (
          sql.startsWith(
            "UPDATE research_ingest_tasks SET state='pending',output=NULL",
          )
        ) {
          // Interpret the bounded UPDATE, including its rank and state filters.
          const rank = /rank>\$(\d+)/.exec(sql);
          const lower = rank
            ? args[Number(rank[1]) - 1]
            : Number(/rank>(\d+)/.exec(sql)![1]);
          for (const task of tasks)
            if (
              task.rank > lower &&
              ["succeeded", "reused", "skipped"].includes(task.state)
            ) {
              task.state = "pending";
              task.output = null;
            }
        } else if (sql.startsWith("SELECT source_record_id FROM")) {
          return {
            rows:
              tasks.find((t) => t.stage === "verify")!.state === "pending"
                ? [{ source_record_id: "record" }]
                : [],
          };
        } else if (sql.startsWith("WITH blocked_records")) {
          return {
            rows: tasks.filter(
              (t) => !["succeeded", "reused", "skipped"].includes(t.state),
            ),
          };
        } else if (sql.startsWith("SELECT stage,state")) {
          return { rows: tasks.map((t) => ({ ...t, records: 1 })) };
        } else if (sql.startsWith("UPDATE research_ingest_attempts")) {
          attempts.push(args[0]);
        }
        // Remaining statements seed the unchanged fixture, persist counters/issues or verification receipts.
        return { rows: [], rowCount: 1 };
      },
    };
    const db = { ...client, connect: async () => client } as unknown as Pool;
    const ex = {
      id: "execution",
      stopped: false,
      stopReason: "",
      abortController: new AbortController(),
      check() {},
    } as unknown as Execution;
    const result = await runRecordScheduler({
      db,
      ex,
      run: "run",
      concurrency: 1,
      finiteBudget: false,
      shadow: false,
      execute: async (claim: TaskClaim) => {
        executions.push(claim.stage);
        let output: AttemptResult;
        if (claim.stage === "geocode") {
          await withAttemptContext(
            {
              runId: "run",
              execution: ex,
              stage: claim.stage,
              claim,
              attemptId: "geocode-new",
            },
            () =>
              artifactTransaction(db, async () => {
                geocode = "geocode-v2";
                embedding = null;
                build = { id: "build-without-embedding", embedding, geocode };
                return {
                  value: undefined,
                  output: { status: completion, geocode_id: geocode },
                };
              }),
          );
          return;
        }
        if (claim.stage === "embed") {
          assert.equal(embedding, null);
          embedding = "embedding-new";
          output = { status: "succeeded", embedding_id: embedding };
        } else {
          assert.equal(
            embedding,
            "embedding-new",
            "old completed checkpoints must not bypass re-embedding",
          );
          if (claim.stage === "match")
            build = { id: "build-current", embedding, geocode };
          assert.equal(build.embedding, embedding);
          assert.equal(build.geocode, geocode);
          output = {
            status: "succeeded",
            embedding_id: embedding,
            geocode_id: geocode,
            build_id: build.id,
          };
        }
        await finishTask(
          client as unknown as PoolClient,
          claim,
          `new-${claim.stage}`,
          output,
        );
      },
    });
    assert.deepEqual(commits[0], {
      embedding: null,
      geocode: "geocode-v2",
      states: [
        "succeeded",
        completion,
        "pending",
        "pending",
        "pending",
        "pending",
      ],
    });
    assert.deepEqual(executions, [
      "geocode",
      "embed",
      "match",
      "canonical",
      "verify",
    ]);
    assert.equal(result.partial, false);
    assert.equal(tasks.at(-1)!.output!.build_id, "build-current");
    assert.equal(
      attempts[0],
      "old-successful-attempt",
      "prior evidence is append-only",
    );
  });
}

for (const changed of [
  "region",
  "city",
  "country_code",
  "address",
  "none",
] as const) {
  test(`cached location activation ${changed}: embedding invalidation follows changed locality`, async () => {
    const source = {
      country_code: "US",
      city: "Austin",
      region: "Texas",
      address: "Official address",
    };
    const row = {
      id: "poi",
      name: "Camp",
      name_normalized: "camp",
      category_slugs: ["campground"],
      ...source,
      lat: 30,
      lng: -97,
      coordinate_source: "source",
      coordinate_precision: "point",
      geocode_query_norm: null,
      active_normalization_id: "normalization",
      active_geocode_id: "geocode-old",
      active_embedding_id: "embedding-old" as string | null,
      content_embedding: [1] as number[] | null,
      canonical_poi_id: null,
      captured: { ...source, region: null },
    };
    if (changed !== "none")
      row[changed] = changed === "country_code" ? "CA" : "Old value";
    const before = buildEmbedText(row);
    const client = {
      release() {},
      async query(sql: string, args: any[] = []) {
        if (sql.startsWith("SELECT rp.id")) return { rows: [{ id: row.id }] };
        if (sql.startsWith("SELECT rp.*,o.captured"))
          return { rows: [{ ...row }] };
        if (sql.startsWith("SELECT slug FROM canonical_categories"))
          return { rows: [] };
        if (sql.startsWith("SELECT lat, lng, precision"))
          return { rows: [{ lat: row.lat, lng: row.lng, precision: "point" }] };
        if (sql.startsWith("SELECT payload"))
          return {
            rows: [
              {
                payload: {
                  hit: {
                    ...source,
                    region_code: "US-TX",
                    postcode: "78701",
                    distance_m: 0,
                    provider: "locationiq",
                    attribution: "fixture",
                  },
                },
              },
            ],
          };
        if (sql.includes("INSERT INTO research_poi_geocodes"))
          return { rows: [{ id: "geocode-new" }] };
        if (sql.startsWith("UPDATE research_pois SET lat=")) {
          // Evaluate the actual SQL's CASE predicates against the old row, as PostgreSQL does.
          for (const field of [
            "content_embedding",
            "active_embedding_id",
          ] as const) {
            const predicate = new RegExp(
              `${field}=CASE WHEN ([\\s\\S]*?) THEN NULL`,
            ).exec(sql)![1];
            assert.ok(
              predicate,
              `Expected an explicit invalidation predicate for ${field}`,
            );
            const differs = [
              ...predicate.matchAll(/(\w+) IS DISTINCT FROM \$(\d+)/g),
            ].some(
              ([, key, position]) =>
                (row as any)[key!] !== args[Number(position) - 1],
            );
            if (differs) (row as any)[field] = null;
          }
          Object.assign(row, {
            country_code: args[1],
            city: args[2],
            region: args[3],
            address: args[4],
            active_geocode_id: args[5],
          });
        } else
          assert.ok(
            ["BEGIN", "COMMIT", "ROLLBACK"].includes(sql),
            `Unexpected fixture query: ${sql}`,
          );
        return { rows: [], rowCount: 1 };
      },
    };
    const db = { ...client, connect: async () => client } as unknown as Pool;
    const stats = await runGeocode(db, {
      recordId: row.id,
      limit: 1,
      geocodeLimit: 0,
      throttleMs: 0,
      dryRun: false,
    });
    assert.equal(stats.apiCalls, 0);
    assert.equal(stats.cacheHits, 2);
    assert.equal(stats.resolved, 1);
    assert.equal(row.active_geocode_id, "geocode-new");
    assert.equal(row.region, "Texas");
    assert.deepEqual([row.lat, row.lng], [30, -97]);
    assert.equal(row.address, source.address);
    const invalidated = ["region", "city", "country_code"].includes(changed);
    assert.equal(row.active_embedding_id, invalidated ? null : "embedding-old");
    assert.deepEqual(row.content_embedding, invalidated ? null : [1]);
    if (changed === "region" || changed === "city")
      assert.notEqual(buildEmbedText(row), before);
  });
}
