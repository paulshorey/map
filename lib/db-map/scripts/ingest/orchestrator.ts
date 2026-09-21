import { prepareStageQueue } from "./work-queue.js";
import { spawn } from "node:child_process";
import { Execution, lockSource, type AttemptResult } from "./execution.js";
import { runGeocode } from "./geocode.js";
import { runEmbed } from "./embed.js";
import { runMatch } from "./match.js";
import { ingestConfig } from "./config.js";
import { verifyLineage } from "./verify.js";
import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { parseGenericRecords } from "./extractors/generic.js";
import { rawContentHash } from "./hash.js";
import { runHybridNormalize } from "./normalize/runner.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
import {
  hashSourceFile,
  resolveSourceFile,
  type ResolvedSourceFile,
} from "./source-file.js";
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
  | "consolidate"
  | "verify"
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
  resume?: string;
  record?: string;
  consolidate?: boolean;
}

interface ExtractStats {
  seen: number;
  inserted: number;
  changed: number;
  unchanged: number;
  rejected: number;
  failed: number;
  duplicates: number;
  collisions: number;
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

async function ensureSource(
  db: Pool,
  resolved: ResolvedSourceFile,
): Promise<string> {
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
  if (opts.maxLlmRequests !== undefined)
    args.push("--max-llm-requests", String(opts.maxLlmRequests));
  if (opts.maxCostUsd !== undefined)
    args.push("--max-cost-usd", String(opts.maxCostUsd));
  if (opts.geocodeLimit !== undefined)
    args.push("--geocode-limit", String(opts.geocodeLimit));
  if (opts.stopAfter) args.push("--stop-after", opts.stopAfter);
  if (opts.fromStage) args.push("--from", opts.fromStage);
  if (opts.reprocess) args.push("--reprocess", opts.reprocess);
  if (opts.retryFailed) args.push("--retry-failed");
  if (opts.record) args.push("--record", opts.record);
  return args
    .map((arg) =>
      /^[a-zA-Z0-9_./:-]+$/.test(arg)
        ? arg
        : "'" + arg.replaceAll("'", "'\\''") + "'",
    )
    .join(" ");
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
      opts.shadow
        ? "shadow"
        : opts.reprocess
          ? "reprocess"
          : opts.fromStage
            ? "from_stage"
            : "resume",
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

/**
 * Produce the exact record stream used by the file-first extractor stage.
 *
 * Maintenance commands which act on a file must use this rather than parsing the
 * file independently: custom extractors can synthesize source ids and registered
 * files can declare a wrapper path.
 */
export async function* recordsFor(
  resolved: ResolvedSourceFile,
): AsyncIterable<RawRecord> {
  const custom = getExtractor(resolved.source.meta.slug);
  if (custom) {
    yield* custom.parse(resolved.absolutePath);
    return;
  }
  if (resolved.file.wrapperPath) {
    const parsed = JSON.parse(
      await readFile(resolved.absolutePath, "utf8"),
    ) as Record<string, unknown>;
    const records = parsed[resolved.file.wrapperPath];
    if (!Array.isArray(records)) {
      throw new Error(
        `Expected array at wrapper path "${resolved.file.wrapperPath}" in ${resolved.logicalPath}`,
      );
    }
    // Wrapper files are bounded JSON documents. Reuse the generic parser's identity
    // policy after counting URLs so shared feed/homepage URLs never become keys.
    const { mapGenericRecord } = await import("./extractors/generic.js");
    const urls = new Map<string, number>();
    for (const raw of records) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      const url =
        typeof value.detail_url === "string"
          ? value.detail_url
          : typeof value.source_url === "string"
            ? value.source_url
            : typeof value.url === "string"
              ? value.url
              : undefined;
      if (url) urls.set(url, (urls.get(url) ?? 0) + 1);
    }
    const uniqueUrls = new Set(
      [...urls].filter(([, count]) => count === 1).map(([url]) => url),
    );
    for (const raw of records) {
      const record = mapGenericRecord(raw, {
        sourceSlug: resolved.source.meta.slug,
        field: resolved.source.identity?.field,
        editioned: resolved.source.identity?.editioned,
        uniqueUrls,
      });
      if (record) yield record;
    }
    return;
  }
  yield* parseGenericRecords(resolved.absolutePath, {
    sourceSlug: resolved.source.meta.slug,
    field: resolved.source.identity?.field,
    editioned: resolved.source.identity?.editioned,
  });
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
    [
      ctx.runId,
      ctx.fileVersionId,
      record.source_record_id || null,
      ordinal,
      hash,
    ],
  );
  return rows[0]!.id;
}

async function observeRecord(
  client: PoolClient,
  ctx: RunContext,
  record: RawRecord,
  sourceIsPoi: boolean,
  rawHash: ReturnType<typeof rawContentHash>,
): Promise<{
  state: "inserted" | "changed" | "unchanged";
  poiId: string;
  observationId: string;
}> {
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
         source_record_id_kind, identity_inputs,
         normalization_state
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
         $16,$17,$18::jsonb,$19::jsonb,$20,$21,$22::jsonb,'pending'
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
        record.source_record_id_kind ?? "natural",
        record.identity_inputs ? JSON.stringify(record.identity_inputs) : null,
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
         source_record_id_kind = $20, identity_inputs = $21::jsonb,
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
        record.source_record_id_kind ?? "natural",
        record.identity_inputs ? JSON.stringify(record.identity_inputs) : null,
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

function recordLabel(record: RawRecord): string {
  return record.source_record_id || record.name || "unknown";
}

function formatRecordName(record: RawRecord): string {
  if (!record.name) return "";
  return ` "${record.name.replace(/"/g, "'")}"`;
}

function logExtractRecord(
  ordinal: number,
  record: RawRecord,
  outcome:
    | { kind: "ok"; state: "inserted" | "changed" | "unchanged" }
    | { kind: "rejected"; reason: string }
    | { kind: "failed"; error: string },
): void {
  const id = recordLabel(record);
  const name = formatRecordName(record);
  if (outcome.kind === "ok") {
    console.log(`extract ok #${ordinal} ${outcome.state} ${id}${name}`);
    return;
  }
  if (outcome.kind === "rejected") {
    console.log(
      `extract rejected #${ordinal} ${id}${name} (${outcome.reason})`,
    );
    return;
  }
  console.log(`extract failed #${ordinal} ${id}${name} (${outcome.error})`);
}

async function extractFile(
  db: Pool,
  ctx: RunContext,
  opts: OrchestratorOptions,
  execution?: Execution,
): Promise<ExtractStats> {
  const stats: ExtractStats = {
    seen: 0,
    inserted: 0,
    changed: 0,
    unchanged: 0,
    rejected: 0,
    failed: 0,
    duplicates: 0,
    collisions: 0,
  };
  await db.query(
    `UPDATE research_source_file_versions SET status = 'extracting' WHERE id = $1`,
    [ctx.fileVersionId],
  );
  console.log(`Extract: starting ${ctx.resolved.logicalPath}`);
  const extractor = getExtractor(ctx.resolved.source.meta.slug);

  let ordinal = 0;
  const seenIds = new Map<string, { hash: string; ordinal: number }>();
  try {
    for await (const record of recordsFor(ctx.resolved)) {
      if (execution?.stopped) break;
      execution?.check();
      if (opts.limit !== undefined && stats.seen >= opts.limit) break;
      ordinal++;
      if (opts.record && record.source_record_id !== opts.record) continue;
      stats.seen++;
      const hash = rawContentHash(record.raw);
      const runRecordId = await upsertRunRecord(
        db,
        ctx,
        ordinal,
        record,
        hash.hash,
      );
      if (!record.source_record_id) {
        stats.rejected++;
        await db.query(
          `UPDATE research_ingest_run_records SET extract_state='rejected',
             last_error_class='missing_source_record_id',
             last_error='Record has no stable source id'
           WHERE id=$1`,
          [runRecordId],
        );
        logExtractRecord(ordinal, record, {
          kind: "rejected",
          reason: "missing source_record_id",
        });
        continue;
      }
      const prior = seenIds.get(record.source_record_id);
      if (prior) {
        if (prior.hash === hash.hash) {
          stats.duplicates++;
          await db.query(
            `UPDATE research_ingest_run_records SET extract_state='duplicate',
               last_error_class='duplicate_source_record_id',
               last_error=$2 WHERE id=$1`,
            [
              runRecordId,
              `Duplicate of ordinal ${prior.ordinal} with identical raw content`,
            ],
          );
          console.log(
            `extract duplicate #${ordinal} ${recordLabel(record)} (same as #${prior.ordinal})`,
          );
        } else {
          stats.collisions++;
          await db.query(
            `UPDATE research_ingest_run_records SET extract_state='collision',
               last_error_class='source_record_id_collision',
               last_error=$2 WHERE id=$1`,
            [
              runRecordId,
              `Collides with ordinal ${prior.ordinal}; records have different raw content`,
            ],
          );
          console.error(
            `extract collision #${ordinal} ${recordLabel(record)} (conflicts with #${prior.ordinal})`,
          );
        }
        continue;
      }
      seenIds.set(record.source_record_id, { hash: hash.hash, ordinal });

      const client = await db.connect();
      try {
        const write = async () => {
          await client.query("BEGIN");
          const sourceIsPoi = extractor?.isPoi
            ? extractor.isPoi(record.raw)
            : true;
          const result = await observeRecord(
            client,
            ctx,
            record,
            sourceIsPoi,
            hash,
          );
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
          return {
            status: "succeeded" as const,
            state: result.state,
            research_poi_id: result.poiId,
            observation_id: result.observationId,
          };
        };
        const outcome = execution
          ? await execution.attempt(
              "extract",
              `record:${ordinal}`,
              {
                source_record_id: record.source_record_id,
                ordinal,
                raw_hash: hash.hash,
              },
              write,
            )
          : await write();
        const state = outcome.state as "inserted" | "changed" | "unchanged";
        stats[state]++;
        logExtractRecord(ordinal, record, { kind: "ok", state });
      } catch (error) {
        await client.query("ROLLBACK");
        stats.failed++;
        const message = (error as Error).message.slice(0, 500);
        await db.query(
          `UPDATE research_ingest_run_records SET extract_state='failed',
             last_error_class=$2, last_error=$3
           WHERE id=$1`,
          [
            runRecordId,
            (error as { code?: string }).code ?? "record_write_error",
            message.slice(0, 2000),
          ],
        );
        logExtractRecord(ordinal, record, { kind: "failed", error: message });
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

  const complete =
    !execution?.stopped &&
    !opts.record &&
    opts.limit === undefined &&
    stats.failed === 0 &&
    stats.collisions === 0 &&
    stats.rejected === 0;
  if (complete) {
    if (ctx.resolved.mode === "snapshot") {
      await retireMissingSnapshotRows(db, ctx);
    }
    await db.query(
      `UPDATE research_source_files SET active_version_id=$2, last_seen_at=now() WHERE id=$1`,
      [ctx.sourceFileId, ctx.fileVersionId],
    );
  }
  await db.query(
    `UPDATE research_source_file_versions SET
       status=$2, record_count=$3, completed_at=CASE WHEN $2='complete' THEN now() ELSE NULL END
     WHERE id=$1`,
    [
      ctx.fileVersionId,
      stats.collisions > 0 ? "failed" : complete ? "complete" : "partial",
      stats.seen,
    ],
  );
  return stats;
}

async function retireMissingSnapshotRows(
  db: Pool,
  ctx: RunContext,
): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{
      id: string;
      canonical_poi_id: string | null;
    }>(
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
        await rebuildCanonicalPoi(client, row.canonical_poi_id, {
          noLlm: true,
        });
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
  values: {
    stage?: IngestStage;
    status?: string;
    counters?: unknown;
    error?: string;
  },
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
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "";
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      tail = (tail + String(chunk)).slice(-8000);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      tail = (tail + String(chunk)).slice(-8000);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) reject(new Error(`${name} terminated by ${signal}`));
      else if (code !== 0) reject(new Error(`${name} exited ${code}: ${tail}`));
      else resolvePromise(0);
    });
  });
}

function ctxRepoRoot(): string {
  return new URL("../../../../", import.meta.url).pathname;
}

interface RunItem {
  source_record_id: string;
  research_poi_id: string | null;
  observation_id: string | null;
}

async function freezeItems(
  db: Pool,
  ctx: RunContext,
  opts: OrchestratorOptions,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `WITH records AS (
      SELECT DISTINCT ON (rr.source_record_id) rr.source_record_id, rr.research_poi_id,
        rr.observation_id, rr.source_ordinal
      FROM research_ingest_run_records rr JOIN research_ingest_runs r ON r.id=rr.run_id
      WHERE rr.source_file_version_id=$2 AND rr.extract_state IN ('written','unchanged')
        AND r.category_slug=$3 AND rr.source_record_id IS NOT NULL
      ORDER BY rr.source_record_id, rr.last_attempt_at DESC, rr.id DESC
    )
    INSERT INTO research_ingest_run_items(run_id,source_record_id,research_poi_id,observation_id,source_ordinal)
    SELECT $1, r.source_record_id, r.research_poi_id, r.observation_id, r.source_ordinal
    FROM records r LEFT JOIN research_pois rp ON rp.id=r.research_poi_id
    WHERE ($4::text IS NULL OR r.source_record_id=$4)
      AND (NOT $5::boolean OR rp.normalization_state IN ('failed','active_stale'))
    ORDER BY r.source_ordinal,r.source_record_id LIMIT $6
    ON CONFLICT DO NOTHING`,
      [
        ctx.runId,
        ctx.fileVersionId,
        opts.category,
        opts.record ?? null,
        opts.retryFailed,
        opts.limit ?? null,
      ],
    );
    await client.query(
      `UPDATE research_ingest_runs SET counters=counters || jsonb_build_object('scope_frozen',true)
    WHERE id=$1`,
      [ctx.runId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function recordState(db: Pool, item: RunItem) {
  if (!item.research_poi_id || !item.observation_id)
    throw new Error(
      `Run input ${item.source_record_id} was deleted; start a new run`,
    );
  const { rows } = await db.query(
    `SELECT rp.id,rp.active_observation_id,rp.active_normalization_id,
    rp.normalization_state,rp.is_poi,rp.lat,rp.lng,rp.name_normalized,rp.category_slugs,
    (rp.content_embedding IS NOT NULL) AS has_embedding,rp.active_embedding_id,rp.active_geocode_id,
    rp.canonical_poi_id,rp.retired_at,cp.active_build_id,cp.status AS canonical_status
    FROM research_pois rp LEFT JOIN canonical_pois cp ON cp.id=rp.canonical_poi_id WHERE rp.id=$1`,
    [item.research_poi_id],
  );
  const state = rows[0];
  if (
    !state ||
    state.retired_at ||
    state.active_observation_id !== item.observation_id
  ) {
    throw new Error(
      `Input changed for ${item.source_record_id}; this run is pinned to its original observation`,
    );
  }
  return state;
}

export async function runOrchestration(
  db: Pool,
  supplied: OrchestratorOptions,
): Promise<void> {
  let opts = { ...supplied };
  let previous: any;
  if (opts.resume) {
    const { rows } = await db.query(
      `SELECT r.*,f.logical_path,v.file_sha256,v.extractor_version
      FROM research_ingest_runs r JOIN research_source_file_versions v ON v.id=r.source_file_version_id
      JOIN research_source_files f ON f.id=v.source_file_id WHERE r.id=$1`,
      [opts.resume],
    );
    previous = rows[0];
    if (!previous) throw new Error(`Unknown run ${opts.resume}`);
    const overrides = Object.fromEntries(
      Object.entries(supplied).filter(
        ([k, v]) =>
          ["maxLlmRequests", "maxCostUsd", "geocodeLimit"].includes(k) &&
          v !== undefined,
      ),
    );
    opts = {
      ...previous.options,
      ...overrides,
      stopAfter: supplied.stopAfter,
      resume: previous.id,
      dryRun: supplied.dryRun,
    };
    if (
      previous.managed &&
      JSON.stringify(previous.pipeline_versions) !==
        JSON.stringify(PIPELINE_VERSIONS)
    ) {
      // JSONB key order is not stable: compare values below instead.
      if (
        Object.entries(PIPELINE_VERSIONS).some(
          ([k, v]) => previous.pipeline_versions[k] !== v,
        )
      )
        throw new Error(
          "Pipeline versions changed; start a new file run instead of resuming an old scope",
        );
    }
  }
  if (
    (opts.fromStage === "consolidate" || opts.stopAfter === "consolidate") &&
    !opts.consolidate
  )
    throw new Error(
      "The consolidate stage requires --consolidate on the original run",
    );
  const stageOrder = [
    "extract",
    "normalize",
    "geocode",
    "embed",
    "match",
    "canonical",
    "consolidate",
    "report",
    "verify",
  ];
  if (
    opts.fromStage &&
    opts.stopAfter &&
    stageOrder.indexOf(opts.fromStage) > stageOrder.indexOf(opts.stopAfter)
  )
    throw new Error("--stop-after must not precede --from");
  const resolved = await resolveSourceFile(opts.file, opts.category);
  const hashed = await hashSourceFile(resolved.absolutePath);
  if (previous && resolved.extractorVersion !== previous.extractor_version)
    throw new Error("Extractor version changed; start a new run");
  if (previous && hashed.sha256 !== previous.file_sha256)
    throw new Error("Source file changed; start a new run for this version");
  if (opts.dryRun) {
    console.log(
      JSON.stringify(
        {
          file: resolved.logicalPath,
          source: resolved.source.meta.slug,
          options: opts,
          sha256: hashed.sha256,
        },
        null,
        2,
      ),
    );
    return;
  }
  const lock = await lockSource(db, resolved.source.meta.slug);
  let execution: Execution | undefined;
  let ctx: RunContext;
  try {
    if (previous?.managed) {
      ctx = {
        resolved,
        sourceId: previous.source_id,
        sourceFileId: "",
        fileVersionId: previous.source_file_version_id,
        runId: previous.id,
        fileHash: hashed.sha256,
        fileAlreadyComplete: false,
      };
      const { rows } = await db.query(
        "SELECT source_file_id,status FROM research_source_file_versions WHERE id=$1",
        [ctx.fileVersionId],
      );
      ctx.sourceFileId = rows[0].source_file_id;
      ctx.fileAlreadyComplete = rows[0].status === "complete";
    } else {
      ctx = await createRunContext(db, resolved, opts);
      await db.query(
        `UPDATE research_ingest_runs SET managed=true,resumed_from_run_id=$2,
        resume_command=$3 WHERE id=$1`,
        [
          ctx.runId,
          previous?.id ?? null,
          `pnpm --filter @lib/db-map ingest:run --resume ${ctx.runId}`,
        ],
      );
    }
    execution = await Execution.start(db, ctx.runId, opts, lock);
  } catch (error) {
    lock.release(true);
    throw error;
  }
  const ex = execution;
  console.log(
    `${previous?.managed ? "Resuming" : "Created NEW"} run ${ctx.runId}; execution ${ex.id}; source=${resolved.source.meta.slug}`,
  );
  console.log(`Local journal: ${ex.logPath}`);
  console.log(
    `Resume: pnpm --filter @lib/db-map ingest:run --resume ${ctx.runId}`,
  );
  let finalStatus = "succeeded",
    reason = "requested_scope_verified";
  try {
    const scope = (
      await db.query("SELECT counters FROM research_ingest_runs WHERE id=$1", [
        ctx.runId,
      ])
    ).rows[0].counters;
    if (!scope.scope_frozen) {
      const extract = await ex.attempt(
        "extract",
        "file",
        { file: resolved.logicalPath, sha256: hashed.sha256 },
        async () => {
          if (
            ctx.fileAlreadyComplete &&
            opts.reprocess !== "extract" &&
            opts.reprocess !== "all"
          )
            return { status: "reused" };
          const stats = await extractFile(db, ctx, opts, ex);
          await updateRun(db, ctx, { counters: { extract: stats } });
          if (stats.failed || stats.collisions || stats.rejected)
            throw new Error(`Extraction incomplete: ${JSON.stringify(stats)}`);
          return { status: ex.stopped ? "paused" : "succeeded", ...stats };
        },
      );
      if (extract.status === "paused" || ex.stopped) {
        finalStatus = "paused";
        reason = ex.stopReason || "extraction_paused";
        return;
      }
      await freezeItems(db, ctx, opts);
    }
    if (opts.stopAfter === "extract") {
      finalStatus = "paused";
      reason = "stop_after_extract";
      return;
    }
    const { rows: items } = await db.query<RunItem>(
      "SELECT * FROM research_ingest_run_items WHERE run_id=$1 ORDER BY source_ordinal,source_record_id",
      [ctx.runId],
    );
    if (!items.length) {
      finalStatus = "partial";
      reason = "empty_scope";
      return;
    }
    const changed = (
      await db.query(
        `SELECT i.source_record_id FROM research_ingest_run_items i
      LEFT JOIN research_pois rp ON rp.id=i.research_poi_id
      WHERE i.run_id=$1 AND (rp.id IS NULL OR rp.retired_at IS NOT NULL OR rp.active_observation_id IS DISTINCT FROM i.observation_id
        OR EXISTS (SELECT 1 FROM research_ingest_attempts a WHERE a.run_id=i.run_id AND a.stage='normalize'
          AND a.target_key=i.source_record_id AND a.status IN ('succeeded','reused') AND a.output->>'active'='true'
          AND a.output->>'normalization_id' IS DISTINCT FROM rp.active_normalization_id::text)) LIMIT 1`,
        [ctx.runId],
      )
    ).rows[0];
    if (changed)
      throw new Error(
        `Pinned input/output changed for ${changed.source_record_id}; start a new run`,
      );

    const stages = ["normalize", "geocode", "embed", "match", "canonical"];
    const ordered = ["extract", ...stages, "consolidate", "report", "verify"];
    const start = opts.fromStage ? ordered.indexOf(opts.fromStage) : 0;
    let geocodeCalls = 0;
    for (const stage of stages) {
      if (start > ordered.indexOf(stage)) continue;
      const queue = await prepareStageQueue(db, ex, stage, items.length, {
        source: resolved.source.meta.slug,
        runId: ctx.runId,
        noLlm: opts.noLlm,
        shadow: opts.shadow,
        reprocess: opts.reprocess === "normalize" || opts.reprocess === "all",
        generation: ctx.runId,
        retryFailed: false,
      });
      if (ex.stopped) {
        finalStatus = "paused";
        reason = ex.stopReason;
        return;
      }
      for (const item of queue.items) {
        ex.check();
        if (ex.stopped) {
          finalStatus = "paused";
          reason = ex.stopReason;
          return;
        }
        const result = await ex.attempt(
          stage,
          item.source_record_id,
          { ...item, observation_id: item.observation_id },
          async (): Promise<AttemptResult> => {
            const state = await recordState(db, item);
            if (stage === "normalize") {
              const budget =
                opts.maxLlmRequests !== undefined ||
                opts.maxCostUsd !== undefined
                  ? (
                      await db.query(
                        `SELECT count(*)::int AS requests,COALESCE(sum(estimated_cost_usd),0)::float AS cost
              FROM research_normalization_requests q JOIN research_ingest_attempts a ON a.id=q.ingest_attempt_id
              WHERE a.execution_id=$1`,
                        [ex.id],
                      )
                    ).rows[0]
                  : { requests: 0, cost: 0 };
              const stats = await runHybridNormalize(db, {
                source: resolved.source.meta.slug,
                recordId: item.research_poi_id!,
                runId: ctx.runId,
                noLlm: opts.noLlm,
                shadow: opts.shadow,
                reprocess:
                  opts.reprocess === "normalize" || opts.reprocess === "all",
                generation: ctx.runId,
                retryFailed: false,
                maxRequests:
                  opts.maxLlmRequests === undefined
                    ? undefined
                    : Math.max(0, opts.maxLlmRequests - budget.requests),
                maxCostUsd:
                  opts.maxCostUsd === undefined
                    ? undefined
                    : Math.max(0, opts.maxCostUsd - budget.cost),
              });
              if (stats.stoppedByBudget)
                return { status: "waiting_budget", ...stats };
              if (stats.failed || !stats.processed)
                throw new Error(
                  `Normalization did not complete: ${JSON.stringify(stats)}`,
                );
              const after = await recordState(db, item);
              return {
                status: stats.cacheHits ? "reused" : "succeeded",
                ...stats,
                normalization_id: stats.artifactId,
                active: stats.artifactId === after.active_normalization_id,
              };
            }
            if (
              !state.active_normalization_id ||
              ["failed", "pending", "active_stale"].includes(
                state.normalization_state,
              )
            )
              return { status: "blocked", reason: "normalization_required" };
            if (!state.is_poi)
              return {
                status: "skipped",
                reason: "non_poi",
                normalization_id: state.active_normalization_id,
              };
            if (stage === "geocode") {
              if (state.lat !== null && state.lng !== null)
                return {
                  status: "reused",
                  reason: "coordinates_present",
                  geocode_id: state.active_geocode_id,
                };
              const stats = await runGeocode(db, {
                recordId: item.research_poi_id!,
                geocodeLimit: Math.max(
                  0,
                  (opts.geocodeLimit ?? 4500) - geocodeCalls,
                ),
                throttleMs: 1000,
                dryRun: false,
              });
              geocodeCalls += stats.apiCalls;
              if (stats.budgetHit)
                return { status: "waiting_budget", ...stats };
              const after = await recordState(db, item);
              return {
                status:
                  after.lat !== null && after.lng !== null
                    ? "succeeded"
                    : "blocked",
                reason: stats.noQuery ? "missing_locality" : "geocode_result",
                ...stats,
                geocode_id: after.active_geocode_id,
              };
            }
            if (stage === "embed") {
              if (state.has_embedding && state.active_embedding_id)
                return {
                  status: "reused",
                  embedding_id: state.active_embedding_id,
                };
              const stats = await runEmbed(db, {
                recordId: item.research_poi_id!,
                batchSize: 1,
                throttleMs: 200,
                dryRun: false,
              });
              const after = await recordState(db, item);
              return {
                status:
                  after.has_embedding && after.active_embedding_id
                    ? "succeeded"
                    : "blocked",
                ...stats,
                embedding_id: after.active_embedding_id,
              };
            }
            if (stage === "match") {
              if (state.canonical_poi_id)
                return {
                  status: "reused",
                  canonical_id: state.canonical_poi_id,
                  build_id: state.active_build_id,
                };
              if (
                state.lat === null ||
                state.lng === null ||
                !state.name_normalized ||
                !state.category_slugs
              )
                return { status: "blocked", reason: "match_prerequisites" };
              const stats = await runMatch(
                db,
                {
                  source: resolved.source.meta.slug,
                  recordId: item.research_poi_id!,
                  runId: ctx.runId,
                  limit: 1,
                  dryRun: false,
                  noLlm: opts.noLlm,
                  recluster: false,
                  gcOrphans: false,
                  consolidate: false,
                  consolidateOnly: false,
                  tHigh: ingestConfig.match.tHigh,
                  tLow: ingestConfig.match.tLow,
                },
                { requested: false, count: 0 },
              );
              const after = await recordState(db, item);
              if (!after.canonical_poi_id)
                throw new Error("Matcher returned without a canonical link");
              return {
                status: "succeeded",
                ...stats,
                canonical_id: after.canonical_poi_id,
                build_id: after.active_build_id,
              };
            }
            return {
              status:
                state.canonical_poi_id && state.active_build_id
                  ? "succeeded"
                  : "blocked",
              canonical_id: state.canonical_poi_id,
              build_id: state.active_build_id,
              publication_status: state.canonical_status,
            };
          },
          true,
          async (previous) => {
            if (stage === "normalize") return true;
            const state = await recordState(db, item);
            if (!state.is_poi) return previous.status === "skipped";
            if (stage === "geocode")
              return (
                state.lat !== null &&
                state.lng !== null &&
                previous.geocode_id === state.active_geocode_id
              );
            if (stage === "embed")
              return (
                state.has_embedding &&
                !!state.active_embedding_id &&
                previous.embedding_id === state.active_embedding_id
              );
            return (
              !!state.canonical_poi_id &&
              !!state.active_build_id &&
              previous.canonical_id === state.canonical_poi_id &&
              previous.build_id === state.active_build_id
            );
          },
        );
        if (result.status === "paused") {
          finalStatus = "paused";
          reason = ex.stopReason || `${stage}:paused`;
          return;
        }
        if (["waiting_budget", "blocked"].includes(result.status)) {
          finalStatus =
            result.status === "waiting_budget" ? "waiting_budget" : "partial";
          reason = `${stage}:${result.reason ?? result.status}`;
          return;
        }
      }
      if (opts.stopAfter === stage || (stage === "normalize" && opts.shadow)) {
        finalStatus = "paused";
        reason = opts.shadow ? "shadow_complete" : `stop_after_${stage}`;
        return;
      }
    }
    if (opts.consolidate) {
      if (opts.limit !== undefined || opts.record)
        throw new Error(
          "Global consolidation cannot be combined with a limited record scope",
        );
      await ex.attempt("consolidate", "global", {}, async () => {
        const stats = await runMatch(
          db,
          {
            dryRun: false,
            noLlm: opts.noLlm,
            recluster: false,
            gcOrphans: false,
            consolidate: true,
            consolidateOnly: true,
            tHigh: ingestConfig.match.tHigh,
            tLow: ingestConfig.match.tLow,
          },
          {
            get requested() {
              return ex.stopped;
            },
            count: 0,
          },
        );
        return { status: stats.stopped ? "paused" : "succeeded", ...stats };
      });
    }
    if (opts.stopAfter === "consolidate") {
      finalStatus = "paused";
      reason = "stop_after_consolidate";
      return;
    }
    if (ex.stopped) {
      finalStatus = "paused";
      reason = ex.stopReason;
      return;
    }
    await ex.attempt(
      "report",
      "run",
      {},
      async () => {
        const code = await runCommand("ingest:report", [
          "--source",
          resolved.source.meta.slug,
          "--category",
          opts.category,
        ]);
        if (code !== 0) throw new Error(`Report exited ${code}`);
        return { status: "succeeded" };
      },
      false,
    );
    ex.check();
    if (ex.stopped || opts.stopAfter === "report") {
      finalStatus = "paused";
      reason = ex.stopReason || "stop_after_report";
      return;
    }
    await ex.attempt(
      "verify",
      "lineage",
      {},
      async () => {
        const { rows: incomplete } = await db.query(
          `SELECT i.source_record_id FROM research_ingest_run_items i
          LEFT JOIN research_pois rp ON rp.id=i.research_poi_id
          LEFT JOIN canonical_pois cp ON cp.id=rp.canonical_poi_id
          WHERE i.run_id=$1 AND (rp.id IS NULL OR rp.retired_at IS NOT NULL
            OR rp.active_observation_id IS DISTINCT FROM i.observation_id
            OR rp.active_normalization_id IS NULL OR rp.normalization_state IN ('pending','failed','active_stale')
            OR (rp.is_poi AND (rp.lat IS NULL OR rp.lng IS NULL OR rp.content_embedding IS NULL
              OR rp.active_embedding_id IS NULL OR cp.active_build_id IS NULL))) LIMIT 10`,
          [ctx.runId],
        );
        if (incomplete.length)
          throw new Error(
            `Scope verification: incomplete records ${incomplete.map((row) => row.source_record_id).join(", ")}`,
          );
        const violations = await verifyLineage(db);
        if (violations)
          throw new Error(`Lineage verification: ${violations} violation(s)`);
        return { status: "succeeded", violations };
      },
      false,
    );
    await db.query(
      "UPDATE research_ingest_runs SET verified_at=now() WHERE id=$1",
      [ctx.runId],
    );
  } catch (error) {
    finalStatus = "failed";
    reason =
      (error as { code?: string })?.code === "provider_recovery_exhausted"
        ? "provider_recovery_exhausted"
        : "stage_error";
    await ex.finish("failed", reason, error);
    throw error;
  } finally {
    // Catch already finalized failures above; successful/paused returns finalize here.
    await ex.finish(finalStatus, reason);
    console.log(
      `Run ${ctx.runId}: ${reason}. Inspect: pnpm --filter @lib/db-map ingest:status --run ${ctx.runId}`,
    );
    if (finalStatus !== "succeeded") process.exitCode = 2;
  }
}
