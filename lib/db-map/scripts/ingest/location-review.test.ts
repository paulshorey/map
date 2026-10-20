import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import {
  sampleLocationReview,
  type LocationReviewRow,
} from "../../sql/ingestion-location-review.js";
import {
  makePacket,
  renderPacket,
  decisionTemplate,
  summarizeReviews,
} from "./location-review/model.js";
import { parseReviewArgs, parseSelectionManifest } from "./location-review.js";

function row(): LocationReviewRow {
  return {
    source: "jambase",
    source_record_id: "fixture:event",
    research_id: "research",
    canonical_id: "canonical",
    build_id: "build",
    normalization_id: "norm",
    observation_id: "obs",
    geocode_id: "geo",
    source_file_version_id: "file",
    logical_path: "fixture.json",
    raw_content_hash: "rawhash",
    capture_hash: "capturehash",
    completion: { run_id: "completed", verified_at: "2026-10-16T20:00:00Z" },
    stratum: "risk",
    raw: {
      venue: {
        country: "Switzerland",
        countryCode: "CH",
        streetAddress: "Source venue road",
        city: "Köniz",
        lat: 6.9185,
        lng: 7.4402,
      },
    },
    captured: {
      name: "Fixture festival",
      country_code: "CH",
      address: "Source venue road",
      city: "Köniz",
      lat: 6.9185,
      lng: 7.4402,
      attributes: {},
    },
    normalized: {
      display_name: "Fixture festival",
      country_code: "CH",
      city: "Köniz",
      address: "Source venue road",
      starts_at: "2026-07-15T00:00:00Z",
    },
    geocode: {
      normalization_id: "norm",
      lat: 6.9185,
      lng: 7.4402,
      status: "resolved",
      precision: "point",
      validation: {
        normalization_id: "norm",
        point: { lat: 6.9185, lng: 7.4402 },
        reverse: {
          country_code: "NG",
          city: "Aka",
          region: "Enugu",
          address: "Reverse road",
          distance_m: 32,
        },
      },
    },
    canonical: {
      name: "Fixture festival",
      lat: 6.9185,
      lng: 7.4402,
      address: "Source venue road",
      attributes: { country_code: "CH", city: "Köniz" },
    },
    projection: {
      lat: 6.9185,
      lng: 7.4402,
      country_code: "CH",
      active_normalization_id: "norm",
      active_geocode_id: "geo",
    },
  };
}
const packet = (r = row()) =>
  makePacket(
    {
      observed_at: "2026-10-16T21:00:00Z",
      population: [{ source: r.source, stratum: r.stratum, records: 100 }],
      rows: [r],
    },
    { limit: 1, seed: "test" },
  );
test("detects source-point-country contradiction with exact immutable and canonical field locators", () => {
  const c = packet().cases[0]!;
  assert.ok(c.findings.some((f) => f.code === "listed_country_vs_reverse"));
  assert.deepEqual(c.fields["listed.country"]!.path, ["venue", "country"]);
  assert.equal(c.fields["listed.country"]!.table, "research_poi_observations");
  assert.equal(c.fields["listed.country"]!.row_id, "obs");
  assert.deepEqual(c.fields["reverse.country_code"]!.path, [
    "reverse",
    "country_code",
  ]);
  assert.equal(c.fields["reverse.country_code"]!.row_id, "geo");
  assert.equal(c.fields["canonical.country_code"]!.column, "attributes");
  assert.deepEqual(c.fields["canonical.country_code"]!.path, ["country_code"]);
  assert.equal(c.fields["listed.lat"]!.value, 6.9185);
  assert.equal(c.fields["geocode.lat"]!.value, 6.9185);
  assert.equal(c.reverse_comparable, true);
});
test("normalizes country aliases and accent/case differences without asserting errors", () => {
  const r = row();
  r.raw.venue = {
    country: "United Kingdom",
    countryCode: "GB",
    city: "São Paulo",
    state: "TX",
  };
  r.captured.country_code = "GB";
  r.canonical.attributes = { country_code: "GB", city: "Sao Paulo" };
  (r.geocode!.validation as any).reverse = {
    country_code: "gb",
    city: "Sao Paulo",
    region: "Texas",
    region_code: "US-TX",
  };
  const c = packet(r).cases[0]!;
  assert.ok(
    !c.findings.some((f) =>
      [
        "listed_country_vs_reverse",
        "listed_country_vs_canonical",
        "listed_city_vs_reverse",
        "listed_region_vs_reverse",
      ].includes(f.code),
    ),
  );
});
test("unbound or absent reverse evidence stays unassessed, never treated as agreement", () => {
  const r = row();
  (r.geocode!.validation as any).normalization_id = "other-normalization";
  let c = packet(r).cases[0]!;
  assert.equal(c.reverse_comparable, false);
  assert.ok(
    c.findings.some((f) => f.code === "reverse_lineage_or_point_unbound"),
  );
  assert.ok(!c.findings.some((f) => f.code === "listed_country_vs_reverse"));
  r.geocode = null;
  r.geocode_id = null;
  c = packet(r).cases[0]!;
  assert.ok(c.findings.some((f) => f.code === "reverse_not_available"));
  assert.equal(c.reverse_address, null);
});
test("an artifact belonging to another normalization cannot certify the point", () => {
  const r = row();
  r.geocode!.normalization_id = "other";
  const c = packet(r).cases[0]!;
  assert.equal(c.reverse_comparable, false);
  assert.ok(
    c.findings.some((f) => f.code === "reverse_lineage_or_point_unbound"),
  );
  assert.equal(
    c.fields["geocode.artifact_normalization_id"]!.column,
    "normalization_id",
  );
});
test("unbound reverse findings identify each failed binding predicate", async (t) => {
  const scenarios: Array<{
    name: string;
    change: (r: LocationReviewRow) => void;
    fields: string[];
  }> = [
    {
      name: "artifact normalization",
      change: (r) => {
        r.geocode!.normalization_id = "other-artifact";
      },
      fields: ["geocode.artifact_normalization_id"],
    },
    {
      name: "validation normalization",
      change: (r) => {
        (r.geocode!.validation as any).normalization_id = "other-validation";
      },
      fields: ["geocode.normalization_id"],
    },
    {
      name: "unresolved artifact status",
      change: (r) => {
        r.geocode!.status = "rejected";
      },
      fields: ["geocode.status"],
    },
    {
      name: "different saved query point",
      change: (r) => {
        (r.geocode!.validation as any).point = { lat: 47, lng: 8 };
      },
      fields: ["geocode.lat", "geocode.lng", "geocode.point"],
    },
    {
      name: "invalid artifact point",
      change: (r) => {
        r.geocode!.lat = null;
      },
      fields: ["geocode.lat", "geocode.lng", "geocode.point"],
    },
    {
      name: "multiple failed predicates",
      change: (r) => {
        r.geocode!.normalization_id = "other-artifact";
        r.geocode!.status = "miss";
      },
      fields: ["geocode.artifact_normalization_id", "geocode.status"],
    },
  ];
  for (const scenario of scenarios)
    await t.test(scenario.name, () => {
      const r = row();
      scenario.change(r);
      const p = packet(r),
        c = p.cases[0]!;
      const finding = c.findings.find(
        (f) => f.code === "reverse_lineage_or_point_unbound",
      );
      assert.equal(c.reverse_comparable, false);
      assert.deepEqual(finding?.fields, scenario.fields);
      assert.ok(finding!.fields.every((id) => Object.hasOwn(c.fields, id)));
      assert.ok(
        !c.findings.some((f) => f.code === "listed_country_vs_reverse"),
      );
      const rendered = renderPacket(p);
      for (const id of scenario.fields) assert.ok(rendered.includes(id));
      if (scenario.name === "artifact normalization") {
        assert.equal(
          c.fields["geocode.artifact_normalization_id"]!.value,
          "other-artifact",
        );
        assert.equal(c.fields["geocode.normalization_id"]!.value, "norm");
      }
      if (scenario.name === "unresolved artifact status")
        assert.deepEqual(c.fields["geocode.status"], {
          stage: "geocode",
          table: "research_poi_geocodes",
          row_id: "geo",
          column: "status",
          path: [],
          value: "rejected",
        });
    });
});
test("unrecognized country findings cite the raw or captured field that supplied the name", () => {
  for (const rawCountry of ["Atlantis", "", undefined]) {
    const r = row();
    r.raw.venue = rawCountry === undefined ? {} : { country: rawCountry };
    r.captured.attributes = { country_name: "Atlantis" };
    const p = packet(r),
      c = p.cases[0]!;
    const id = rawCountry ? "listed.country" : "captured.country_name";
    assert.equal(c.listed.country, "Atlantis");
    assert.deepEqual(
      c.findings.find((f) => f.code === "listed_country_not_recognized")
        ?.fields,
      [id],
    );
    assert.equal(c.fields[id]!.value, "Atlantis");
    assert.equal(c.fields[id]!.table, "research_poi_observations");
    assert.equal(c.fields[id]!.row_id, "obs");
    assert.equal(c.fields[id]!.column, rawCountry ? "raw" : "captured");
    assert.deepEqual(
      c.fields[id]!.path,
      rawCountry ? ["venue", "country"] : ["attributes", "country_name"],
    );
    assert.ok(renderPacket(p).includes(id));
  }
});
test("country disagreements identify the captured fallback fields that supplied the values", () => {
  for (const rawCountry of [true, false]) {
    const r = row();
    r.raw.venue = rawCountry ? { country: "Switzerland" } : {};
    r.captured.country_code = "NG";
    r.captured.attributes = { country_name: "Switzerland" };
    const c = packet(r).cases[0]!;
    assert.deepEqual(
      c.findings.find((f) => f.code === "listed_country_fields_disagree")
        ?.fields,
      [
        rawCountry ? "listed.country" : "captured.country_name",
        "captured.country_code",
      ],
    );
    assert.equal(c.fields["captured.country_code"]!.value, "NG");
    assert.equal(c.fields["listed.country_code"]!.value, null);
  }
});
test("an unrecognized country code falls back to the recognized country name's field", () => {
  const r = row();
  r.raw.venue = { country: "Switzerland", countryCode: "invalid" };
  r.canonical.attributes = { country_code: "NG" };
  const c = packet(r).cases[0]!;
  for (const code of [
    "listed_country_vs_reverse",
    "listed_country_vs_canonical",
  ])
    assert.equal(
      c.findings.find((f) => f.code === code)?.fields[0],
      "listed.country",
    );
});
test("zero-pair canonical points are conflicts; missing optional fields remain coverage gaps", () => {
  const r = row();
  r.canonical.lat = 0;
  r.canonical.lng = 0;
  const c = packet(r).cases[0]!;
  assert.equal(
    c.findings.find((f) => f.code === "canonical_point_invalid")?.kind,
    "conflict",
  );
  assert.equal(
    c.findings.find((f) => f.code === "canonical_region_missing")?.kind,
    "coverage",
  );
});
test("separates alias/municipality/address differences and excessive lookup distance", () => {
  const r = row();
  (r.geocode!.validation as any).reverse.distance_m = 2500;
  const c = packet(r).cases[0]!;
  assert.equal(
    c.findings.find((f) => f.code === "listed_city_vs_reverse")?.kind,
    "difference",
  );
  assert.equal(
    c.findings.find((f) => f.code === "listed_address_vs_reverse")?.kind,
    "difference",
  );
  assert.ok(c.findings.some((f) => f.code === "reverse_result_too_distant"));
  assert.ok(
    c.findings.every((f) =>
      f.fields.every((id) => Object.hasOwn(c.fields, id)),
    ),
  );
});
test("detects coordinate changes at extraction, geocode and canonical selection separately", () => {
  const r = row();
  r.captured.lat = 46.9;
  r.canonical.lat = 48;
  const c = packet(r).cases[0]!;
  assert.ok(
    c.findings.some((f) => f.code === "listed_point_changed_at_extraction"),
  );
  assert.ok(
    c.findings.some((f) => f.code === "captured_point_changed_at_geocode"),
  );
  assert.ok(
    c.findings.some((f) => f.code === "canonical_point_far_from_member"),
  );
});
test("source hints remain visible even when policy intentionally clears administrative columns", () => {
  const r = row();
  r.source = "thatfestivalsite";
  r.raw = { country: "Australia", city: "Australia" };
  r.captured = {
    attributes: {
      source_location_hints: { country: "Australia", city: "Australia" },
      location_admin_policy: "coordinate_lookup",
    },
  };
  const c = packet(r).cases[0]!;
  assert.equal(c.listed.country, "Australia");
  assert.equal(c.context.location_policy, "coordinate_lookup");
  assert.deepEqual(c.fields["captured.location_hints"]!.path, [
    "attributes",
    "source_location_hints",
  ]);
});
test("case identity binds current build and artifacts; evidence hash catches in-place changes", () => {
  const r = row(),
    a = packet(r).cases[0]!;
  r.build_id = "new-build";
  assert.notEqual(packet(r).cases[0]!.case_id, a.case_id);
  r.build_id = "build";
  r.canonical.address = "Changed";
  const b = packet(r).cases[0]!;
  assert.equal(b.case_id, a.case_id);
  assert.notEqual(b.evidence_hash, a.evidence_hash);
});
function judgments(p = packet()) {
  return {
    ...decisionTemplate(p),
    reviewer: "Human fixture",
    reviewed_at: "2026-10-16T21:00:00Z",
    cases: [
      {
        case_id: p.cases[0]!.case_id,
        evidence_hash: p.cases[0]!.evidence_hash,
        field_reviews: [
          {
            field_id: "reverse.country_code",
            scope: "coordinate_lookup",
            verdict: "correct",
            note: "Matches point in fixture",
          },
          {
            field_id: "reverse.country_code",
            scope: "event_location",
            verdict: "incorrect",
            note: "Event venue in CH",
          },
          {
            field_id: "listed.country",
            scope: "event_location",
            verdict: "correct",
            note: "Official venue evidence",
          },
        ],
      },
    ],
  };
}
test("manual labels distinguish correct lookup from correct event location, grouped by source/field/stage", () => {
  const p = packet(),
    summary = summarizeReviews(p, judgments(p));
  assert.equal(summary.reviewed_fields, 3);
  assert.equal(summary.groups.length, 3);
  assert.ok(
    summary.groups.some(
      (g) =>
        g.table === "research_poi_observations" &&
        g.stage === "capture" &&
        g.correct === 1,
    ),
  );
  assert.ok(
    summary.groups.some(
      (g) => g.scope === "coordinate_lookup" && g.correct === 1,
    ),
  );
  assert.ok(
    summary.groups.some(
      (g) => g.scope === "event_location" && g.incorrect === 1,
    ),
  );
});
test("rejects stale labels, changed packets, duplicate judgments and unknown fields/scopes", () => {
  const p = packet();
  let d = judgments(p);
  d.packet_id = "old";
  assert.throws(() => summarizeReviews(p, d), /mismatch/);
  d = judgments(p);
  d.cases[0]!.evidence_hash = "old";
  assert.throws(() => summarizeReviews(p, d), /stale/);
  d = judgments(p);
  p.cases[0]!.fields["listed.country"]!.value = "Changed";
  assert.throws(() => summarizeReviews(p, d), /stale/);
  const fresh = packet();
  d = judgments(fresh);
  d.cases[0]!.field_reviews.push(d.cases[0]!.field_reviews[0]!);
  assert.throws(() => summarizeReviews(fresh, d), /Duplicate/);
  d = judgments(fresh);
  d.cases[0]!.field_reviews[0]!.field_id = "unknown";
  assert.throws(() => summarizeReviews(fresh, d), /Unknown field/);
  d = judgments(fresh);
  d.cases[0]!.field_reviews[0]!.field_id = "toString";
  assert.throws(() => summarizeReviews(fresh, d), /Unknown field/);
  d = judgments(fresh);
  d.cases[0]!.field_reviews[0]!.field_id = "listed.country";
  assert.throws(() => summarizeReviews(fresh, d), /scope|coordinate_lookup/);
});
test("CLI rejects unbounded, misspelled, duplicate and incomplete options before database access", () => {
  for (const a of [
    ["--limit", "101"],
    ["--limit", "0"],
    ["--limit", "NaN"],
    ["--limt", "1"],
    ["--run", "x"],
    ["--out", "second"],
    ["--seed"],
  ])
    assert.throws(() => parseReviewArgs(["export", "--out", "folder", ...a]));
  assert.equal(
    parseReviewArgs(["export", "--out", "folder", "--limit", "5"]).flags.limit,
    "5",
  );
  assert.equal(parseReviewArgs(["--help"]).command, "help");
});
test("reports escape raw HTML and pipes while preserving machine-readable values", () => {
  const r = row();
  r.canonical.name = "A | <script>alert(1)</script>";
  const p = packet(r),
    md = renderPacket(p, false);
  assert.ok(md.includes("\\| &lt;script&gt;"));
  assert.ok(!md.includes("<script>"));
  assert.equal(p.cases[0]!.context.name, r.canonical.name);
});
test("database diagnostic enforces read-only snapshot, scope parameters, timeouts and release on error", async () => {
  const queries: Array<{ sql: string; values?: unknown[] }> = [];
  let released = false;
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.startsWith("WITH completed"))
        throw new Error("injected query timeout");
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const db = { connect: async () => client } as unknown as Pool;
  await assert.rejects(
    () =>
      sampleLocationReview(db, { limit: 3, seed: "fixed", source: "fixture" }),
    /timeout/,
  );
  assert.equal(
    queries[0]!.sql,
    "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  );
  assert.ok(queries.some((q) => q.sql.includes("statement_timeout")));
  assert.deepEqual(
    queries.find((q) => q.sql.startsWith("WITH completed"))!.values,
    [null, "fixture", "fixed", 3, null],
  );
  assert.equal(queries.at(-1)!.sql, "ROLLBACK");
  assert.equal(released, true);
  assert.ok(!queries.some((q) => /\b(INSERT|UPDATE|DELETE)\b/.test(q.sql)));
});

test(
  "SQL sampling strata agree with rendered reverse binding",
  {
    skip: !process.env.LOCATION_REVIEW_TEST_DATABASE_URL,
  },
  async () => {
    const url = new URL(process.env.LOCATION_REVIEW_TEST_DATABASE_URL!);
    assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
    assert.equal(url.pathname, "/map_location_review_test");
    const { Pool } = await import("pg");
    const { randomUUID } = await import("node:crypto");
    const db = new Pool({ connectionString: url.href, max: 1 });
    try {
      // Session-local fixtures: the production query runs unchanged, with no shared tables.
      await db.query(`
      CREATE TEMP TABLE research_sources (id uuid, slug text);
      CREATE TEMP TABLE research_ingest_runs (id uuid, source_id uuid, verified_at timestamptz, options jsonb, status text);
      CREATE TEMP TABLE research_ingest_tasks (run_id uuid, source_record_id text, input jsonb, output jsonb, attempt_id uuid, stage text, state text);
      CREATE TEMP TABLE canonical_pois (id uuid, active_build_id uuid, status text, name text, description text, website text, lat float8, lng float8, address text, attributes jsonb, starts_at text, ends_at text, field_provenance jsonb);
      CREATE TEMP TABLE canonical_poi_builds (id uuid, builder_version text);
      CREATE TEMP TABLE canonical_poi_build_inputs (build_id uuid, research_poi_id uuid, normalization_id uuid, geocode_id uuid);
      CREATE TEMP TABLE research_pois (id uuid, source_id uuid, source_record_id text, lat float8, lng float8, country_code text, city text, region text, address text, active_normalization_id uuid, active_geocode_id uuid);
      CREATE TEMP TABLE research_poi_normalizations (id uuid, research_poi_id uuid, observation_id uuid, display_name text, description text, website text, address text, city text, region text, country_code text, starts_at text, ends_at text, field_evidence jsonb, normalizer_version text, attributes jsonb, venue text, edition_year int);
      CREATE TEMP TABLE research_poi_geocodes (id uuid, normalization_id uuid, lat float8, lng float8, precision text, status text, provider text, provider_version text, query_norm text, validation jsonb, created_at timestamptz);
      CREATE TEMP TABLE research_poi_observations (id uuid, source_file_version_id uuid, raw_content_hash text, capture_hash text, captured jsonb, raw jsonb);
      CREATE TEMP TABLE research_source_file_versions (id uuid, source_file_id uuid);
      CREATE TEMP TABLE research_source_files (id uuid, logical_path text);
    `);
      const source = randomUUID(),
        run = randomUUID();
      await db.query("INSERT INTO research_sources VALUES ($1,'fixture')", [
        source,
      ]);
      await db.query(
        "INSERT INTO research_ingest_runs VALUES ($1,$2,now(),'{}','succeeded')",
        [run, source],
      );
      const expected = new Map<string, string>();
      for (const kind of [
        "baseline",
        "risk",
        "artifact_norm",
        "saved_norm",
        "point",
        "status",
        "zero",
        "range",
        "missing_country",
        "missing_geo",
      ]) {
        const research = randomUUID(),
          build = randomUUID(),
          norm = randomUUID(),
          obs = randomUUID(),
          geo = randomUUID();
        const lat = kind === "zero" ? 0 : kind === "range" ? 100 : 46.9;
        const lng = kind === "zero" ? 0 : 7.4;
        const validation = {
          normalization_id: kind === "saved_norm" ? randomUUID() : norm,
          point: { lat: kind === "point" ? 47 : lat, lng },
          reverse: {
            country_code: kind === "missing_country" ? null : "CH",
            city: "Bern",
          },
          warnings: kind === "baseline" ? [] : ["coordinate_country_conflict"],
        };
        await db.query(
          "INSERT INTO research_ingest_tasks VALUES ($1,$2,$3,$4,$5,'verify','succeeded')",
          [
            run,
            kind,
            { observation_id: obs },
            { normalization_id: norm },
            randomUUID(),
          ],
        );
        await db.query(
          "INSERT INTO canonical_pois (id,active_build_id,status,lat,lng,attributes) VALUES ($1,$2,'published',$3,$4,'{}')",
          [randomUUID(), build, lat, lng],
        );
        await db.query(
          "INSERT INTO canonical_poi_build_inputs VALUES ($1,$2,$3,$4)",
          [build, research, norm, geo],
        );
        await db.query(
          "INSERT INTO research_pois (id,source_id,source_record_id,lat,lng,active_normalization_id,active_geocode_id) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [research, source, kind, lat, lng, norm, geo],
        );
        await db.query(
          "INSERT INTO research_poi_normalizations (id,research_poi_id,observation_id,city,country_code) VALUES ($1,$2,$3,'Bern','CH')",
          [norm, research, obs],
        );
        await db.query(
          "INSERT INTO research_poi_observations (id,raw_content_hash,capture_hash,captured,raw) VALUES ($1,'raw','capture','{}','{}')",
          [obs],
        );
        if (kind !== "missing_geo")
          await db.query(
            "INSERT INTO research_poi_geocodes (id,normalization_id,lat,lng,status,validation) VALUES ($1,$2,$3,$4,$5,$6)",
            [
              geo,
              kind === "artifact_norm" ? randomUUID() : norm,
              lat,
              lng,
              kind === "status" ? "rejected" : "resolved",
              validation,
            ],
          );
        expected.set(
          kind,
          kind === "baseline"
            ? "baseline"
            : kind === "risk"
              ? "risk"
              : "no_bound_reverse",
        );
      }
      const sample = await sampleLocationReview(db, {
        limit: 100,
        seed: "binding-regression",
      });
      assert.equal(sample.rows.length, expected.size);
      for (const r of sample.rows) {
        assert.equal(
          r.stratum,
          expected.get(r.source_record_id),
          r.source_record_id,
        );
        const c = packet(r).cases[0]!;
        assert.equal(
          c.reverse_comparable,
          r.stratum !== "no_bound_reverse",
          r.source_record_id,
        );
      }
      assert.deepEqual(
        Object.fromEntries(
          sample.population.map((p) => [p.stratum, p.records]),
        ),
        {
          baseline: 1,
          risk: 1,
          no_bound_reverse: 8,
        },
      );
      const selectedId = sample.rows[0]!.canonical_id;
      // A second source member with no completed checkpoint must remain visible.
      await db.query(
        "DELETE FROM research_ingest_tasks WHERE source_record_id=$1",
        [sample.rows[0]!.source_record_id],
      );
      const explicit = await sampleLocationReview(db, {
        limit: 100,
        seed: "explicit",
        canonical_ids: [selectedId],
      });
      assert.equal(explicit.rows.length, 1);
      assert.equal(
        explicit.rows[0]!.completion.binding,
        "missing_verification",
      );
      await assert.rejects(
        () =>
          sampleLocationReview(db, {
            limit: 100,
            seed: "missing",
            canonical_ids: [randomUUID()],
          }),
        /lack published/,
      );
      await assert.rejects(
        () =>
          sampleLocationReview(db, {
            limit: 1,
            seed: "overflow",
            canonical_ids: sample.rows.slice(0, 2).map((r) => r.canonical_id),
          }),
        /exceed limit/,
      );
      await db.query(
        "INSERT INTO canonical_poi_build_inputs VALUES ($1,$2,NULL,NULL)",
        [explicit.rows[0]!.build_id, randomUUID()],
      );
      await assert.rejects(
        () =>
          sampleLocationReview(db, {
            limit: 100,
            seed: "incomplete-member",
            canonical_ids: [selectedId],
          }),
        /lack normalization\/observation/,
      );
    } finally {
      await db.end();
    }
  },
);

test("coordinate evidence, owners and forward query are rendered and hash-bound without filling missing slots", () => {
  const r = row();
  const source = {
    lat: 46,
    lng: 7,
    kind: "source",
    origin: "source_coordinates",
    research_id: "source-owner",
  };
  const inferred = {
    lat: 46,
    lng: 7,
    kind: "inferred",
    origin: "listed_address_geocode",
    research_id: "inferred-owner",
    query: "Venue address",
  };
  r.builder_version = "canonical-build-v5";
  r.canonical.attributes = {
    coordinate_evidence: {
      source_coordinates: source,
      inferred_coordinates: inferred,
    },
  };
  (r.geocode!.validation as any).coordinate_evidence = {
    source_coordinates: null,
    inferred_coordinates: inferred,
  };
  (r.geocode!.validation as any).forward = {
    query: "Venue address",
    country_filter: "CH",
  };
  const a = packet(r),
    c = a.cases[0]!;
  assert.equal(a.version, "location-review-v2");
  assert.deepEqual(
    c.fields["canonical.coordinate_evidence.source_coordinates"]!.value,
    source,
  );
  assert.deepEqual(
    c.fields["canonical.coordinate_evidence.inferred_coordinates"]!.value,
    inferred,
  );
  assert.equal(
    c.fields["geocode.coordinate_evidence.source_coordinates"]!.value,
    null,
  );
  assert.deepEqual(c.fields["geocode.forward"]!.path, ["forward"]);
  assert.ok(renderPacket(a).includes("inferred-owner"));
  assert.equal(c.fields["canonical.name"]!.table, "canonical_pois");
  assert.equal(c.fields["normalized.starts_at"]!.value, r.normalized.starts_at);
  assert.equal(c.fields["canonical.starts_at"]!.value, null);
  inferred.query = "Changed query";
  assert.notEqual(packet(r).cases[0]!.evidence_hash, c.evidence_hash);
  const legacy = packet().cases[0]!;
  assert.equal(
    legacy.fields["canonical.coordinate_evidence.inferred_coordinates"]!.value,
    null,
  );
  assert.ok(
    legacy.findings.some(
      (f) =>
        f.code === "named_coordinate_evidence_not_stored" &&
        f.kind === "coverage",
    ),
  );
});

test("explicit manifests are bounded, unique and incompatible with partial source filters", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  assert.deepEqual(
    parseSelectionManifest({
      version: "location-review-selection-v1",
      canonical_ids: [id],
    }),
    [id],
  );
  for (const canonical_ids of [[], [id, id], ["invalid"], Array(101).fill(id)])
    assert.throws(
      () =>
        parseSelectionManifest({
          version: "location-review-selection-v1",
          canonical_ids,
        }),
      /Selection/,
    );
  assert.throws(
    () => parseSelectionManifest({ version: "old", canonical_ids: [id] }),
    /Expected/,
  );
  assert.throws(
    () =>
      parseReviewArgs([
        "export",
        "--out",
        "folder",
        "--selection",
        "manifest.json",
        "--source",
        "jambase",
      ]),
    /cannot combine/,
  );
});

test("offline summary continues to accept immutable v1 packets", () => {
  const p = packet();
  p.version = "location-review-v1";
  assert.equal(summarizeReviews(p, judgments(p)).reviewed_fields, 3);
});
