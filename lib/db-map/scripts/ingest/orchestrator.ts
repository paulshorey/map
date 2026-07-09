import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { genericExtractor, mapGenericRecord } from "./extractors/generic.js";
import { rawContentHash } from "./hash.js";
import { runHybridNormalize } from "./normalize/runner.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import { hashSourceFile, resolveSourceFile, type ResolvedSourceFile } from "./source-file.js";
import { getExtractor } from "./sources.js";
import type { RawRecord } from "./types.js";
import { rebuildCanonicalPoi } from "./merge.js";

export type IngestStage =
  | "extract"
  | "normalize"
  | "geocode"
  | "embed"
  | "match"
  | "canonical"
  | "report";

export interface OrchestratorOptions {
  file: string;
  category: string;
  dryRun: boolean;
  limit?: number;
  stopAfter?: IngestStage;
  fromStage?: IngestStage;
  reprocess?: IngestStage | "all";
  shadow: boolean;
  retryFailed: boolean;
  noLlm: boolean;
  maxLlmRequests?: number;
  maxCostUsd?: number;
  geocodeLimit?: number;
}

interface ExtractStats {
  seen: number;
  inserted: number;
  changed: number;
  unchanged: number;
  rejected: number;
  failed: number;
}

interface RunContext {
  resolved: ResolvedSourceFile;
  sourceId: string;
  sourceFileId: string;
  fileVersionId: string;
  runId: string;
  fileHash: string;
  fileAlreadyComplete: boolean;
}

function capturedRecord(record: RawRecord): Record<string, unknown> {
  return {
    name: record.name ?? null,
    description: record.description ?? null,
    website: record.website ?? null,
    source_url: record.source_url ?? null,
    phone: record.phone ?? null,
    email: record.email ?? null,
    address: record.address ?? null,
    city: record.city ?? null,
    region: record.region ?? null,
    country_code: record.country_code ?? null,
    lat: record.lat ?? null,
    lng: record.lng ?? null,
    raw_category: record.raw_category ?? null,
    attributes: record.attributes ?? {},
  };
}

async function ensureSource(db: Pool, resolved: ResolvedSourceFile): Promise<string> {
  const meta = resolved.source.meta;
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO research_sources (slug, name, homepage, license, attribution, trust)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       homepage = COALESCE(EXCLUDED.homepage, research_sources.homepage),
       license = COALESCE(EXCLUDED.license, research_sources.license),
       attribution = COALESCE(EXCLUDED.attribution, research_sources.attribution),
       trust = EXCLUDED.trust
     RETURNING id`,
    [
      meta.slug,
      meta.name,
      meta.homepage ?? null,
      meta.license ?? null,
      meta.attribution ?? null,
      meta.trust,
    ],
  );
  return rows[0]!.id;
}

function resumeCommand(opts: OrchestratorOptions): string {
  const args = [
    "pnpm",
    "--filter",
    "@lib/db-map",
    "ingest:run",
    opts.file,
    "--category",
    opts.category,
  ];
  if (opts.noLlm) args.push("--no-llm");
  if (opts.shadow) args.push("--shadow");
  if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
  if (opts.maxLlmRequests !== undefined) args.push("--max-llm-requests", String(opts.maxLlmRequests));
  if (opts.maxCostUsd !== undefined) args.push("--max-cost-usd", String(opts.maxCostUsd));
  if (opts.geocodeLimit !== undefined) args.push("--geocode-limit", String(opts.geocodeLimit));
  return args.join(" ");
}

async function createRunContext(
  db: Pool,
  resolved: ResolvedSourceFile,
  opts: OrchestratorOptions,
): Promise<RunContext> {
  const sourceId = await ensureSource(db, resolved);
  const file = await hashSourceFile(resolved.absolutePath);
  const { rows: fileRows } = await db.query<{ id: string }>(
    `INSERT INTO research_source_files (
       source_id, logical_path, category_slug, mode, format, extractor_version, last_seen_at
     ) VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (source_id, logical_path) DO UPDATE SET
       category_slug = EXCLUDED.category_slug,
       mode = EXCLUDED.mode,
       format = EXCLUDED.format,
       extractor_version = EXCLUDED.extractor_version,
       last_seen_at = now()
     RETURNING id`,
    [
      sourceId,
      resolved.logicalPath,
      resolved.file.category,
      resolved.mode,
      resolved.format,
      resolved.extractorVersion,
    ],
  );
  const sourceFileId = fileRows[0]!.id;
  const existing = await db.query<{ id: string; status: string }>(
    `SELECT id, status FROM research_source_file_versions
     WHERE source_file_id = $1 AND file_sha256 = $2 AND extractor_version = $3`,
    [sourceFileId, file.sha256, resolved.extractorVersion],
  );
  const fileAlreadyComplete = existing.rows[0]?.status === "complete";
  const { rows: versionRows } = await db.query<{ id: string }>(
    `INSERT INTO research_source_file_versions (
       source_file_id, file_sha256, byte_size, extractor_version, status
     ) VALUES ($1,$2,$3,$4,'pending')
     ON CONFLICT (source_file_id, file_sha256, extractor_version) DO UPDATE SET
       byte_size = EXCLUDED.byte_size
     RETURNING id`,
    [sourceFileId, file.sha256, file.byteSize, resolved.extractorVersion],
  );
  const fileVersionId = versionRows[0]!.id;
  const { rows: runRows } = await db.query<{ id: string }>(
    `INSERT INTO research_ingest_runs (
       source_file_version_id, source_id, category_slug, mode,
       requested_from_stage, pipeline_versions, options, status,
       resume_command, started_at, heartbeat_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'running',$8,now(),now())
     RETURNING id`,
    [
      fileVersionId,
      sourceId,
      resolved.file.category,
      opts.shadow ? "shadow" : opts.reprocess ? "reprocess" : opts.fromStage ? "from_stage" : "resume",
      opts.fromStage ?? opts.reprocess ?? null,
      JSON.stringify(PIPELINE_VERSIONS),
      JSON.stringify(opts),
      resumeCommand(opts),
    ],
  );
  return {
    resolved,
    sourceId,
    sourceFileId,
    fileVersionId,
    runId: runRows[0]!.id,
    fileHash: file.sha256,
    fileAlreadyComplete,
  };
}

async function* recordsFor(resolved: ResolvedSourceFile): AsyncIterable<RawRecord> {
  const custom = getExtractor(resolved.source.meta.slug);
  if (custom) {
    yield* custom.parse(resolved.absolutePath);
    return;
  }
  if (resolved.file.wrapperPath) {
    const parsed = JSON.parse(await readFile(resolved.absolutePath, "utf8")) as Record<string, unknown>;
    const records = parsed[resolved.file.wrapperPath];
    if (!Array.isArray(records)) {
      throw new Error(
        `Expected array at wrapper path "${resolved.file.wrapperPath}" in ${resolved.logicalPath}`,
      );
    }
    for (const raw of records) {
      const record = mapGenericRecord(raw);
      if (record) yield record;
    }
    return;
  }
  yield* genericExtractor.parse(resolved.absolutePath);
}

async function upsertRunRecord(
  db: Pool,
  ctx: RunContext,
  ordinal: number,
  record: RawRecord,
  hash: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO research_ingest_run_records (
       run_id, source_file_version_id, source_record_id, source_ordinal,
       raw_hash, extract_state, attempts, first_attempt_at, last_attempt_at
     ) VALUES ($1,$2,$3,$4,$5,'pending',1,now(),now())
     ON CONFLICT (run_id, source_ordinal) DO UPDATE SET
       source_record_id = EXCLUDED.source_record_id,
       raw_hash = EXCLUDED.raw_hash,
       attempts = research_ingest_run_records.attempts + 1,
       last_attempt_at = now()
     RETURNING id`,
    [ctx.runId, ctx.fileVersionId, record.source_record_id || null, ordinal, hash],
  );
  return rows[0]!.id;
}

async function observeRecord(
  client: PoolClient,
  ctx: RunContext,
  record: RawRecord,
  sourceIsPoi: boolean,
  rawHash: ReturnType<typeof rawContentHash>,
): Promise<{ state: "inserted" | "changed" | "unchanged"; poiId: string; observationId: string }> {
  const existing = await client.query<{
    id: string;
    active_observation_id: string | null;
    raw_content_hash: string | null;
    active_normalization_id: string | null;
  }>(
    `SELECT rp.id, rp.active_observation_id, o.raw_content_hash, rp.active_normalization_id
     FROM research_pois rp
     LEFT JOIN research_poi_observations o ON o.id = rp.active_observation_id
     WHERE rp.source_id = $1 AND rp.source_record_id = $2
     FOR UPDATE OF rp`,
    [ctx.sourceId, record.source_record_id],
  );

  let poiId: string;
  let state: "inserted" | "changed" | "unchanged";
  const prior = existing.rows[0];
  if (!prior) {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO research_pois (
         source_id, source_record_id, ingest_category,
         name, description, website, source_url, phone, email,
         address, city, region, country_code, lng, lat,
         raw_category, is_poi, raw, attributes, content_hash,
         normalization_state
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$17,$18::jsonb,$19::jsonb,$20,'pending'
       ) RETURNING id`,
      [
        ctx.sourceId,
        record.source_record_id,
        ctx.resolved.file.category,
        record.name ?? null,
        record.description ?? null,
        record.website ?? null,
        record.source_url ?? null,
        record.phone ?? null,
        record.email ?? null,
        record.address ?? null,
        record.city ?? null,
        record.region ?? null,
        record.country_code ?? null,
        record.lng ?? null,
        record.lat ?? null,
        record.raw_category ?? null,
        sourceIsPoi,
        JSON.stringify(rawHash.redacted),
        JSON.stringify(record.attributes ?? {}),
        rawHash.hash,
      ],
    );
    poiId = inserted.rows[0]!.id;
    state = "inserted";
  } else {
    poiId = prior.id;
    state = prior.raw_content_hash === rawHash.hash ? "unchanged" : "changed";
  }

  const observation = await client.query<{ id: string }>(
    `INSERT INTO research_poi_observations (
       research_poi_id, source_file_version_id, raw_content_hash, raw,
       captured, source_is_poi_hint, redacted_paths
     ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
     ON CONFLICT (research_poi_id, raw_content_hash) DO UPDATE SET
       source_file_version_id = EXCLUDED.source_file_version_id,
       last_seen_at = now()
     RETURNING id`,
    [
      poiId,
      ctx.fileVersionId,
      rawHash.hash,
      JSON.stringify(rawHash.redacted),
      JSON.stringify(capturedRecord(record)),
      sourceIsPoi,
      rawHash.redactedPaths,
    ],
  );
  const observationId = observation.rows[0]!.id;

  if (state === "unchanged") {
    await client.query(
      `UPDATE research_pois SET last_seen_at = now(), ingest_category = $2,
         active_observation_id = $3, retired_at = NULL
       WHERE id = $1`,
      [poiId, ctx.resolved.file.category, observationId],
    );
  } else if (state === "changed") {
    await client.query(
      `UPDATE research_pois SET
         last_seen_at = now(), ingest_category = $2,
         name = $3, description = $4, website = $5, source_url = $6,
         phone = $7, email = $8, address = $9, city = $10, region = $11,
         country_code = $12, lng = $13, lat = $14, raw_category = $15,
         raw = $16::jsonb, attributes = $17::jsonb, content_hash = $18,
         active_observation_id = $19, normalization_state =
           CASE WHEN active_normalization_id IS NULL THEN 'pending' ELSE 'active_stale' END,
         retired_at = NULL
       WHERE id = $1`,
      [
        poiId,
        ctx.resolved.file.category,
        record.name ?? null,
        record.description ?? null,
        record.website ?? null,
        record.source_url ?? null,
        record.phone ?? null,
        record.email ?? null,
        record.address ?? null,
        record.city ?? null,
        record.region ?? null,
        record.country_code ?? null,
        record.lng ?? null,
        record.lat ?? null,
        record.raw_category ?? null,
        JSON.stringify(rawHash.redacted),
        JSON.stringify(record.attributes ?? {}),
        rawHash.hash,
        observationId,
      ],
    );
  } else {
    await client.query(
      `UPDATE research_pois SET active_observation_id = $2 WHERE id = $1`,
      [poiId, observationId],
    );
  }
  return { state, poiId, observationId };
}

async function extractFile(
  db: Pool,
  ctx: RunContext,
  opts: OrchestratorOptions,
): Promise<ExtractStats> {
  const stats: ExtractStats = {
    seen: 0,
    inserted: 0,
    changed: 0,
    unchanged: 0,
    rejected: 0,
    failed: 0,
  };
  await db.query(
    `UPDATE research_source_file_versions SET status = 'extracting' WHERE id = $1`,
    [ctx.fileVersionId],
  );
  const extractor = getExtractor(ctx.resolved.source.meta.slug);

  let ordinal = 0;
  try {
    for await (const record of recordsFor(ctx.resolved)) {
      if (opts.limit !== undefined && stats.seen >= opts.limit) break;
      ordinal++;
      stats.seen++;
      const hash = rawContentHash(record.raw);
      const runRecordId = await upsertRunRecord(db, ctx, ordinal, record, hash.hash);
      if (!record.source_record_id) {
        stats.rejected++;
        await db.query(
          `UPDATE research_ingest_run_records SET extract_state='rejected',
             last_error_class='missing_source_record_id',
             last_error='Record has no stable source id'
           WHERE id=$1`,
          [runRecordId],
        );
        continue;
      }

      const client = await db.connect();
      try {
        await client.query("BEGIN");
        const sourceIsPoi = extractor?.isPoi ? extractor.isPoi(record.raw) : true;
        const result = await observeRecord(client, ctx, record, sourceIsPoi, hash);
        await client.query(
          `UPDATE research_ingest_run_records SET
             extract_state=$2, research_poi_id=$3, observation_id=$4,
             last_error_class=NULL, last_error=NULL
           WHERE id=$1`,
          [
            runRecordId,
            result.state === "unchanged" ? "unchanged" : "written",
            result.poiId,
            result.observationId,
          ],
        );
        await client.query("COMMIT");
        stats[result.state]++;
      } catch (error) {
        await client.query("ROLLBACK");
        stats.failed++;
        await db.query(
          `UPDATE research_ingest_run_records SET extract_state='failed',
             last_error_class=$2, last_error=$3
           WHERE id=$1`,
          [
            runRecordId,
            (error as { code?: string }).code ?? "record_write_error",
            (error as Error).message.slice(0, 2000),
          ],
        );
      } finally {
        client.release();
      }
    }
  } catch (error) {
    await db.query(
      `UPDATE research_source_file_versions SET status='failed', error=$2 WHERE id=$1`,
      [ctx.fileVersionId, (error as Error).message],
    );
    throw error;
  }

  const complete = opts.limit === undefined && stats.failed === 0;
  await db.query(
    `UPDATE research_source_file_versions SET
       status=$2, record_count=$3, completed_at=CASE WHEN $2='complete' THEN now() ELSE NULL END
     WHERE id=$1`,
    [ctx.fileVersionId, complete ? "complete" : "partial", stats.seen],
  );
  if (complete) {
    if (ctx.resolved.mode === "snapshot") {
      await retireMissingSnapshotRows(db, ctx);
    }
    await db.query(
      `UPDATE research_source_files SET active_version_id=$2, last_seen_at=now() WHERE id=$1`,
      [ctx.sourceFileId, ctx.fileVersionId],
    );
  }
  return stats;
}

async function retireMissingSnapshotRows(db: Pool, ctx: RunContext): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; canonical_poi_id: string | null }>(
      `SELECT rp.id, rp.canonical_poi_id
       FROM research_pois rp
       JOIN research_poi_observations o ON o.id = rp.active_observation_id
       JOIN research_source_file_versions previous ON previous.id = o.source_file_version_id
       WHERE previous.source_file_id = $1
         AND o.source_file_version_id <> $2
         AND rp.retired_at IS NULL
         AND NOT EXISTS (
           SELECT 1
           FROM research_ingest_run_records rirr
           WHERE rirr.run_id = $3
             AND rirr.source_record_id = rp.source_record_id
             AND rirr.extract_state IN ('written','unchanged')
         )
       FOR UPDATE OF rp`,
      [ctx.sourceFileId, ctx.fileVersionId, ctx.runId],
    );
    for (const row of rows) {
      await client.query(
        `UPDATE research_pois SET retired_at=now(), canonical_poi_id=NULL WHERE id=$1`,
        [row.id],
      );
      await client.query(
        `UPDATE research_canonical_memberships
         SET active=false, retired_at=now(), retirement_reason='source_snapshot_removed'
         WHERE research_poi_id=$1 AND active`,
        [row.id],
      );
      if (row.canonical_poi_id) {
        await rebuildCanonicalPoi(client, row.canonical_poi_id, { noLlm: true });
      }
    }
    await client.query("COMMIT");
    return rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updateRun(
  db: Pool,
  ctx: RunContext,
  values: { stage?: IngestStage; status?: string; counters?: unknown; error?: string },
): Promise<void> {
  await db.query(
    `UPDATE research_ingest_runs SET
       current_stage=COALESCE($2,current_stage),
       status=COALESCE($3,status),
       counters=CASE WHEN $4::jsonb IS NULL THEN counters ELSE counters || $4::jsonb END,
       fatal_error=COALESCE($5,fatal_error),
       heartbeat_at=now(),
       completed_at=CASE WHEN $3 IN ('succeeded','partial','failed') THEN now() ELSE completed_at END
     WHERE id=$1`,
    [
      ctx.runId,
      values.stage ?? null,
      values.status ?? null,
      values.counters === undefined ? null : JSON.stringify(values.counters),
      values.error ?? null,
    ],
  );
}

async function runCommand(name: string, args: string[]): Promise<number> {
  return await new Promise<number>((resolvePromise, reject) => {
    const child = spawn("pnpm", ["--filter", "@lib/db-map", name, ...args], {
      cwd: ctxRepoRoot(),
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${name} terminated by ${signal}`));
      else resolvePromise(code ?? 1);
    });
  });
}

function ctxRepoRoot(): string {
  return new URL("../../../../", import.meta.url).pathname;
}

function stageEnabled(opts: OrchestratorOptions, stage: IngestStage): boolean {
  const order: IngestStage[] = ["extract", "normalize", "geocode", "embed", "match", "canonical", "report"];
  const start = opts.fromStage ? order.indexOf(opts.fromStage) : 0;
  return order.indexOf(stage) >= start;
}

function shouldStop(opts: OrchestratorOptions, stage: IngestStage): boolean {
  return opts.stopAfter === stage;
}

export async function runOrchestration(db: Pool, opts: OrchestratorOptions): Promise<void> {
  const resolved = await resolveSourceFile(opts.file, opts.category);
  const hashed = await hashSourceFile(resolved.absolutePath);
  console.log(
    [
      "# ingest:run",
      `file: ${resolved.logicalPath}`,
      `source: ${resolved.source.meta.slug}`,
      `category: ${resolved.file.category}`,
      `mode: ${resolved.mode}`,
      `sha256: ${hashed.sha256.slice(0, 16)}…`,
      `pipeline: ${PIPELINE_VERSIONS.orchestrator}`,
    ].join("\n"),
  );
  if (opts.dryRun) {
    console.log("dry-run: no database writes or provider calls");
    return;
  }

  const ctx = await createRunContext(db, resolved, opts);
  let partial = false;
  try {
    if (stageEnabled(opts, "extract")) {
      await updateRun(db, ctx, { stage: "extract" });
      const forceExtract = opts.reprocess === "extract" || opts.reprocess === "all" || opts.fromStage === "extract";
      if (ctx.fileAlreadyComplete && !forceExtract) {
        console.log("Extract: file version already complete; skipped");
      } else {
        const extract = await extractFile(db, ctx, opts);
        partial ||= extract.failed > 0 || opts.limit !== undefined;
        await updateRun(db, ctx, { counters: { extract } });
        console.log(
          `Extract: seen=${extract.seen} inserted=${extract.inserted} changed=${extract.changed} ` +
            `unchanged=${extract.unchanged} rejected=${extract.rejected} failed=${extract.failed}`,
        );
      }
      if (shouldStop(opts, "extract")) {
        await updateRun(db, ctx, { status: "paused" });
        return;
      }
    }

    if (stageEnabled(opts, "normalize")) {
      await updateRun(db, ctx, { stage: "normalize" });
      const normalized = await runHybridNormalize(db, {
        runId: ctx.runId,
        source: resolved.source.meta.slug,
        limit: opts.limit,
        noLlm: opts.noLlm,
        shadow: opts.shadow,
        reprocess:
          opts.reprocess === "normalize" ||
          opts.reprocess === "all" ||
          opts.fromStage === "normalize",
        retryFailed: opts.retryFailed,
        maxRequests: opts.maxLlmRequests,
        maxCostUsd: opts.maxCostUsd,
      });
      partial ||= normalized.failed > 0 || normalized.stoppedByBudget;
      await updateRun(db, ctx, { counters: { normalize: normalized } });
      if (normalized.stoppedByBudget) {
        await updateRun(db, ctx, { status: "waiting_budget" });
        return;
      }
      if (shouldStop(opts, "normalize") || opts.shadow) {
        await updateRun(db, ctx, { status: partial ? "partial" : "paused" });
        return;
      }
    }

    if (stageEnabled(opts, "geocode")) {
      await updateRun(db, ctx, { stage: "geocode" });
      const args = ["--source", resolved.source.meta.slug];
      if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
      if (opts.geocodeLimit !== undefined) args.push("--geocode-limit", String(opts.geocodeLimit));
      const code = await runCommand("ingest:geocode", args);
      if (code !== 0) throw new Error(`ingest:geocode exited ${code}`);
      if (shouldStop(opts, "geocode")) {
        await updateRun(db, ctx, { status: "paused" });
        return;
      }
    }

    if (stageEnabled(opts, "embed")) {
      await updateRun(db, ctx, { stage: "embed" });
      const args = ["--source", resolved.source.meta.slug];
      if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
      const code = await runCommand("ingest:embed", args);
      if (code !== 0) throw new Error(`ingest:embed exited ${code}`);
      if (shouldStop(opts, "embed")) {
        await updateRun(db, ctx, { status: "paused" });
        return;
      }
    }

    if (stageEnabled(opts, "match")) {
      await updateRun(db, ctx, { stage: "match" });
      const args = ["--source", resolved.source.meta.slug, "--consolidate"];
      if (opts.limit !== undefined) args.push("--limit", String(opts.limit));
      if (opts.noLlm) args.push("--no-llm");
      const code = await runCommand("ingest:match", args);
      if (code !== 0) throw new Error(`ingest:match exited ${code}`);
      if (shouldStop(opts, "match") || shouldStop(opts, "canonical")) {
        await updateRun(db, ctx, { status: "paused" });
        return;
      }
    }

    await updateRun(db, ctx, { stage: "report", status: partial ? "partial" : "succeeded" });
    const reportCode = await runCommand("ingest:report", ["--source", resolved.source.meta.slug]);
    if (reportCode !== 0) throw new Error(`ingest:report exited ${reportCode}`);
    console.log(`Run ${ctx.runId}: ${partial ? "partial" : "succeeded"}`);
    if (partial) process.exitCode = 2;
  } catch (error) {
    await updateRun(db, ctx, { status: "failed", error: (error as Error).message });
    throw error;
  }
}
