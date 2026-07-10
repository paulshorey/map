import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ingestConfig } from "../config.js";
import { stableHash } from "../hash.js";
import { rebuildCanonicalPoi } from "../merge.js";
import {
  completeChat,
  LlmError,
  type ChatMessage,
  type ChatResult,
} from "../providers/deepinfra.js";
import { getSourceDefinition } from "../sources.js";
import { normalizationProfileForCategory } from "../taxonomy.js";
import { loadValidSlugs, resolveCategorySlugs } from "./category.js";
import {
  EXAMPLES_VERSION,
  NORMALIZATION_JSON_SCHEMA,
  NORMALIZER_VERSION,
  parseNormalizationOutput,
  PROMPT_VERSION,
  SCHEMA_VERSION,
  type LlmNormalizationOutput,
} from "./contracts.js";
import {
  buildDeterministicFacts,
  type DeterministicInput,
} from "./deterministic.js";
import { fewShotMessages } from "./examples.js";
import { getNormalizationProfile } from "./profiles.js";
import { NORMALIZATION_SYSTEM_PROMPT } from "./prompt.js";
import { resolveNormalization, type ResolvedNormalization } from "./resolve.js";

export interface NormalizeOptions {
  runId?: string;
  source?: string;
  limit?: number;
  noLlm: boolean;
  shadow: boolean;
  reprocess: boolean;
  retryFailed: boolean;
  maxRequests?: number;
  maxCostUsd?: number;
}

export interface NormalizeRunStats {
  selected: number;
  processed: number;
  cacheHits: number;
  llmRequests: number;
  accepted: number;
  degraded: number;
  rejected: number;
  failed: number;
  costUsd: number;
  stoppedByBudget: boolean;
}

interface NormalizeRow {
  id: string;
  source_slug: string;
  source_record_id: string;
  ingest_category: string;
  ingest_categories: string[] | null;
  active_observation_id: string;
  active_normalization_id: string | null;
  active_input_hash: string | null;
  active_match_fingerprint: string | null;
  canonical_poi_id: string | null;
  name: string | null;
  description: string | null;
  website: string | null;
  source_url: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  country_code: string | null;
  lat: number | null;
  lng: number | null;
  raw_category: string | null;
  attributes: Record<string, unknown> | null;
  raw: unknown;
  source_is_poi_hint: boolean | null;
  raw_content_hash: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(content.slice(start, end + 1));
    throw new Error("DeepSeek response was not valid JSON");
  }
}

function deterministicInput(row: NormalizeRow): DeterministicInput {
  return {
    name: row.name,
    description: row.description,
    website: row.website,
    source_url: row.source_url,
    phone: row.phone,
    email: row.email,
    address: row.address,
    city: row.city,
    region: row.region,
    country_code: row.country_code,
    lat: row.lat,
    lng: row.lng,
    attributes: row.attributes ?? {},
    raw: row.raw,
    sourceIsPoiHint: row.source_is_poi_hint,
  };
}

function requestPacket(
  row: NormalizeRow,
  profileId: string,
  deterministic: ReturnType<typeof buildDeterministicFacts>,
  categorySlugs: string[],
): Record<string, unknown> {
  return {
    record_id: row.id,
    source: {
      slug: row.source_slug,
      profile: profileId,
    },
    source_record_id: row.source_record_id,
    ingest_category: row.ingest_category,
    ingest_categories: categorySlugs,
    captured: {
      name: row.name,
      description: row.description,
      website: row.website,
      source_url: row.source_url,
      phone: row.phone,
      email: row.email,
      address: row.address,
      city: row.city,
      region: row.region,
      country_code: row.country_code,
      lat: row.lat,
      lng: row.lng,
      raw_category: row.raw_category,
      attributes: row.attributes,
    },
    raw: row.raw,
    deterministic,
    allowed_category_slugs: categorySlugs,
  };
}

async function fetchRows(db: Pool, opts: NormalizeOptions): Promise<NormalizeRow[]> {
  const values: unknown[] = [];
  let sourceClause = "";
  if (opts.source) {
    values.push(opts.source);
    sourceClause = `AND rs.slug = $${values.length}`;
  }
  const { rows } = await db.query<NormalizeRow>(
    `SELECT
       rp.id, rs.slug AS source_slug, rp.source_record_id, rp.ingest_category,
       rp.ingest_categories,
       rp.active_observation_id, rp.active_normalization_id,
       active.input_hash AS active_input_hash,
       active.match_fingerprint AS active_match_fingerprint,
       rp.canonical_poi_id,
       COALESCE(o.captured->>'name', rp.name) AS name,
       COALESCE(o.captured->>'description', rp.description) AS description,
       COALESCE(o.captured->>'website', rp.website) AS website,
       COALESCE(o.captured->>'source_url', rp.source_url) AS source_url,
       COALESCE(o.captured->>'phone', rp.phone) AS phone,
       COALESCE(o.captured->>'email', rp.email) AS email,
       COALESCE(o.captured->>'address', rp.address) AS address,
       COALESCE(o.captured->>'city', rp.city) AS city,
       COALESCE(o.captured->>'region', rp.region) AS region,
       COALESCE(o.captured->>'country_code', rp.country_code) AS country_code,
       COALESCE((o.captured->>'lat')::double precision, rp.lat) AS lat,
       COALESCE((o.captured->>'lng')::double precision, rp.lng) AS lng,
       COALESCE(o.captured->>'raw_category', rp.raw_category) AS raw_category,
       COALESCE(o.captured->'attributes', rp.attributes, '{}'::jsonb) AS attributes,
       o.raw, o.source_is_poi_hint, o.raw_content_hash
     FROM research_pois rp
     JOIN research_sources rs ON rs.id = rp.source_id
     JOIN research_poi_observations o ON o.id = rp.active_observation_id
     LEFT JOIN research_poi_normalizations active ON active.id = rp.active_normalization_id
     WHERE rp.retired_at IS NULL
       AND rp.ingest_category IS NOT NULL
       ${sourceClause}
     ORDER BY rp.first_seen_at, rp.id`,
    values,
  );
  return rows;
}

async function insertRequest(
  db: Pool,
  row: NormalizeRow,
  inputHash: string,
  profileVersion: string,
  requestJson: unknown,
  repairedFromId?: string,
): Promise<string> {
  const id = randomUUID();
  await db.query(
    `INSERT INTO research_normalization_requests (
       id, research_poi_id, observation_id, input_hash,
       prompt_version, schema_version, profile_version, examples_version,
       provider, requested_model, status, request_json, repaired_from_id, attempt
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deepinfra',$9,'started',$10::jsonb,$11,$12)`,
    [
      id,
      row.id,
      row.active_observation_id,
      inputHash,
      PROMPT_VERSION,
      SCHEMA_VERSION,
      profileVersion,
      EXAMPLES_VERSION,
      ingestConfig.llm.model,
      JSON.stringify(requestJson),
      repairedFromId ?? null,
      repairedFromId ? 2 : 1,
    ],
  );
  return id;
}

async function finishRequest(
  db: Pool,
  id: string,
  result: ChatResult | null,
  parsed: unknown,
  error?: unknown,
): Promise<void> {
  await db.query(
    `UPDATE research_normalization_requests SET
       returned_model = $2,
       status = $3,
       response_json = $4::jsonb,
       response_text = $5,
       finish_reason = $6,
       prompt_tokens = $7,
       cached_tokens = $8,
       completion_tokens = $9,
       total_tokens = $10,
       estimated_cost_usd = $11,
       latency_ms = $12,
       error = $13,
       completed_at = now()
     WHERE id = $1`,
    [
      id,
      result?.model ?? null,
      error ? "failed" : "succeeded",
      parsed === undefined ? null : JSON.stringify(parsed),
      result?.content ?? null,
      result?.finishReason ?? null,
      result?.usage.promptTokens ?? null,
      result?.usage.cachedTokens ?? null,
      result?.usage.completionTokens ?? null,
      result?.usage.totalTokens ?? null,
      result?.usage.estimatedCost ?? null,
      result?.latencyMs ?? null,
      error instanceof Error ? error.message : error ? String(error) : null,
    ],
  );
}

async function callNormalizer(
  db: Pool,
  row: NormalizeRow,
  inputHash: string,
  profileId: string,
  profileVersion: string,
  packet: Record<string, unknown>,
): Promise<{ output: LlmNormalizationOutput; result: ChatResult; requestId: string }> {
  const messages: ChatMessage[] = [
    { role: "system", content: NORMALIZATION_SYSTEM_PROMPT },
    ...fewShotMessages(profileId),
    { role: "user", content: JSON.stringify(packet) },
  ];
  const requestId = await insertRequest(db, row, inputHash, profileVersion, { messages });
  let result: ChatResult | null = null;
  let parsed: unknown;
  try {
    try {
      result = await completeChat({
        messages,
        maxTokens: 1800,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "poi_normalization",
            strict: true,
            schema: NORMALIZATION_JSON_SCHEMA,
          },
        },
      });
    } catch (error) {
      if (!(error instanceof LlmError) || error.status !== 400) throw error;
      result = await completeChat({
        messages,
        maxTokens: 1800,
        responseFormat: { type: "json_object" },
      });
    }
    parsed = parseJsonContent(result.content);
    const output = parseNormalizationOutput(parsed, row.id);
    await finishRequest(db, requestId, result, parsed);
    return { output, result, requestId };
  } catch (error) {
    await finishRequest(db, requestId, result, parsed, error);
    if (!result?.content || error instanceof LlmError) throw error;

    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      {
        role: "user",
        content:
          `The response failed validation: ${(error as Error).message}. ` +
          "Return one corrected JSON object matching the schema. Do not explain.",
      },
    ];
    const repairId = await insertRequest(
      db,
      row,
      inputHash,
      profileVersion,
      { messages: repairMessages },
      requestId,
    );
    let repairResult: ChatResult | null = null;
    let repairParsed: unknown;
    try {
      repairResult = await completeChat({
        messages: repairMessages,
        maxTokens: 1800,
        responseFormat: {
          type: "json_schema",
          json_schema: {
            name: "poi_normalization",
            strict: true,
            schema: NORMALIZATION_JSON_SCHEMA,
          },
        },
      });
      repairParsed = parseJsonContent(repairResult.content);
      const repaired = parseNormalizationOutput(repairParsed, row.id);
      await finishRequest(db, repairId, repairResult, repairParsed);
      await db.query(
        `UPDATE research_normalization_requests SET status='repaired' WHERE id=$1`,
        [repairId],
      );
      return { output: repaired, result: repairResult, requestId: repairId };
    } catch (repairError) {
      await finishRequest(db, repairId, repairResult, repairParsed, repairError);
      throw repairError;
    }
  }
}

async function loadCached(
  db: Pool,
  rowId: string,
  inputHash: string,
): Promise<{ id: string; resolved: ResolvedNormalization } | null> {
  const { rows } = await db.query<{
    id: string;
    status: ResolvedNormalization["status"];
    is_poi: boolean;
    invalid_reason: string | null;
    entity_kind: string | null;
    display_name: string | null;
    match_name: string | null;
    edition_year: number | null;
    aliases: string[];
    description: string | null;
    website: string | null;
    website_domain: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
    venue: string | null;
    city: string | null;
    region: string | null;
    country_code: string | null;
    category_slugs: string[];
    starts_at: Date | null;
    ends_at: Date | null;
    date_precision: "day" | "month" | "year" | null;
    attributes: Record<string, string | number | boolean>;
    field_evidence: Record<string, string[]>;
    warnings: string[];
    match_fingerprint: string;
  }>(
    `SELECT * FROM research_poi_normalizations
     WHERE research_poi_id = $1 AND input_hash = $2
       AND status IN ('accepted','degraded','rejected')
     LIMIT 1`,
    [rowId, inputHash],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    resolved: {
      status: row.status,
      isPoi: row.is_poi,
      invalidReason: row.invalid_reason,
      entityKind: row.entity_kind,
      displayName: row.display_name,
      matchName: row.match_name,
      editionYear: row.edition_year,
      aliases: row.aliases ?? [],
      description: row.description,
      website: row.website,
      websiteDomain: row.website_domain,
      phone: row.phone,
      email: row.email,
      address: row.address,
      venue: row.venue,
      city: row.city,
      region: row.region,
      countryCode: row.country_code,
      categorySlugs: row.category_slugs ?? [],
      startsAt: row.starts_at?.toISOString().slice(0, 10) ?? null,
      endsAt: row.ends_at?.toISOString().slice(0, 10) ?? null,
      datePrecision: row.date_precision,
      attributes: row.attributes ?? {},
      fieldEvidence: row.field_evidence ?? {},
      warnings: row.warnings ?? [],
      matchFingerprint: row.match_fingerprint,
    },
  };
}

async function startJob(
  db: Pool,
  row: NormalizeRow,
  inputHash: string,
  runId?: string,
): Promise<string> {
  const claimToken = randomUUID();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO research_pipeline_jobs (
       run_id, target_kind, target_id, stage, desired_input_hash,
       stage_version, status, claim_token, lease_owner, lease_expires_at,
       attempts, started_at
     ) VALUES (
       $1,'observation',$2,'normalize',$3,$4,'leased',$5,$6,now()+interval '10 minutes',1,now()
     )
     ON CONFLICT (target_kind, target_id, stage, desired_input_hash) DO UPDATE SET
       run_id = COALESCE(EXCLUDED.run_id, research_pipeline_jobs.run_id),
       status = 'leased',
       claim_token = EXCLUDED.claim_token,
       lease_owner = EXCLUDED.lease_owner,
       lease_expires_at = EXCLUDED.lease_expires_at,
       attempts = research_pipeline_jobs.attempts + 1,
       started_at = now(),
       error_class = NULL,
       error = NULL
     RETURNING id`,
    [
      runId ?? null,
      row.active_observation_id,
      inputHash,
      NORMALIZER_VERSION,
      claimToken,
      `${process.pid}`,
    ],
  );
  return rows[0]!.id;
}

async function finishJob(
  db: Pool,
  jobId: string,
  status: "succeeded" | "retryable" | "failed" | "quarantined",
  outputArtifactId?: string,
  error?: unknown,
): Promise<void> {
  await db.query(
    `UPDATE research_pipeline_jobs SET
       status=$2,
       output_artifact_id=$3,
       error_class=$4,
       error=$5,
       claim_token=NULL,
       lease_owner=NULL,
       lease_expires_at=NULL,
       completed_at=CASE WHEN $2 IN ('succeeded','failed','quarantined') THEN now() ELSE NULL END,
       next_retry_at=CASE WHEN $2='retryable' THEN now()+interval '1 minute' ELSE NULL END
     WHERE id=$1`,
    [
      jobId,
      status,
      outputArtifactId ?? null,
      error instanceof LlmError ? (error.retryable ? "llm_transient" : "llm_error") : error ? "normalization_error" : null,
      error instanceof Error ? error.message.slice(0, 2000) : error ? String(error).slice(0, 2000) : null,
    ],
  );
}

async function insertNormalization(
  db: Pool,
  row: NormalizeRow,
  inputHash: string,
  requestId: string | null,
  resolved: ResolvedNormalization,
  modelOutput: unknown,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO research_poi_normalizations (
       research_poi_id, observation_id, request_id, input_hash, normalizer_version,
       status, is_poi, invalid_reason, entity_kind, display_name, match_name,
       edition_year, aliases, description, website, website_domain, phone, email,
       address, venue, city, region, country_code, category_slugs,
       starts_at, ends_at, date_precision, attributes, field_evidence,
       model_output, warnings, match_fingerprint
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
       $19,$20,$21,$22,$23,$24,$25,$26,$27,$28::jsonb,$29::jsonb,$30::jsonb,$31,$32
     )
     ON CONFLICT (research_poi_id, input_hash) DO UPDATE SET
       request_id = EXCLUDED.request_id
     RETURNING id`,
    [
      row.id,
      row.active_observation_id,
      requestId,
      inputHash,
      NORMALIZER_VERSION,
      resolved.status,
      resolved.isPoi,
      resolved.invalidReason,
      resolved.entityKind,
      resolved.displayName,
      resolved.matchName,
      resolved.editionYear,
      resolved.aliases,
      resolved.description,
      resolved.website,
      resolved.websiteDomain,
      resolved.phone,
      resolved.email,
      resolved.address,
      resolved.venue,
      resolved.city,
      resolved.region,
      resolved.countryCode,
      resolved.categorySlugs,
      resolved.startsAt,
      resolved.endsAt,
      resolved.datePrecision,
      JSON.stringify(resolved.attributes),
      JSON.stringify(resolved.fieldEvidence),
      JSON.stringify(modelOutput ?? {}),
      resolved.warnings,
      resolved.matchFingerprint,
    ],
  );
  const id = rows[0]!.id;
  if (resolved.startsAt) {
    await db.query(
      `INSERT INTO research_poi_normalization_occurrences (
         normalization_id, starts_at, ends_at, date_precision, edition_year,
         derivation, evidence
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT (normalization_id, starts_at) DO UPDATE SET
         ends_at = EXCLUDED.ends_at,
         date_precision = EXCLUDED.date_precision`,
      [
        id,
        resolved.startsAt,
        resolved.endsAt,
        resolved.datePrecision,
        resolved.editionYear,
        requestId ? "llm_interpretation" : "structured_parse",
        JSON.stringify(resolved.fieldEvidence),
      ],
    );
  }
  return id;
}

async function activateNormalization(
  db: Pool,
  row: NormalizeRow,
  normalizationId: string,
  inputHash: string,
  resolved: ResolvedNormalization,
  shadow: boolean,
): Promise<void> {
  if (shadow) return;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const shouldRematch =
      row.active_match_fingerprint !== null &&
      row.active_match_fingerprint !== resolved.matchFingerprint;
    await client.query(
      `UPDATE research_pois SET
         active_normalization_id = $2::uuid,
         normalization_input_hash = $3,
         normalization_state = $4,
         normalized_at = now(),
         name = COALESCE($5, name),
         name_normalized = $6,
         description = COALESCE($7, description),
         website = $8,
         website_domain = $9,
         phone = $10,
         email = $11,
         address = COALESCE($12, address),
         city = COALESCE($13, city),
         region = COALESCE($14, region),
         country_code = COALESCE($15, country_code),
         is_poi = $16,
         category_slugs = $17,
         starts_at = $18,
         ends_at = $19,
         date_precision = $20,
         lat = COALESCE($21, lat),
         lng = COALESCE($22, lng),
         coordinate_source = COALESCE($23, coordinate_source),
         coordinate_precision = COALESCE($24, coordinate_precision),
         content_embedding = CASE WHEN $25 THEN NULL ELSE content_embedding END,
         canonical_poi_id = CASE WHEN $25 THEN NULL ELSE canonical_poi_id END,
         matched_normalization_id = CASE WHEN $25 THEN NULL ELSE $2::uuid END,
         attributes = COALESCE(attributes, '{}'::jsonb) || $26::jsonb
       WHERE id = $1`,
      [
        row.id,
        normalizationId,
        inputHash,
        resolved.status === "rejected" ? "rejected" : resolved.status === "degraded" ? "degraded" : "active",
        resolved.displayName,
        resolved.matchName,
        resolved.description,
        resolved.website,
        resolved.websiteDomain,
        resolved.phone,
        resolved.email,
        resolved.address,
        resolved.city,
        resolved.region,
        resolved.countryCode,
        resolved.isPoi,
        resolved.categorySlugs,
        resolved.startsAt,
        resolved.endsAt,
        resolved.datePrecision,
        null,
        null,
        null,
        null,
        shouldRematch,
        JSON.stringify({
          ...resolved.attributes,
          ...(resolved.venue ? { venue: resolved.venue } : {}),
          normalization: {
            id: normalizationId,
            input_hash: inputHash,
            warnings: resolved.warnings,
          },
        }),
      ],
    );
    await client.query(
      `UPDATE research_poi_normalizations SET activated_at = now() WHERE id = $1`,
      [normalizationId],
    );
    if (row.canonical_poi_id) {
      await rebuildCanonicalPoi(client as PoolClient, row.canonical_poi_id, { noLlm: true });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runHybridNormalize(
  db: Pool,
  opts: NormalizeOptions,
): Promise<NormalizeRunStats> {
  const rows = await fetchRows(db, opts);
  const validSlugs = await loadValidSlugs(db);
  const reprocessGeneration = opts.reprocess ? randomUUID() : null;
  const stats: NormalizeRunStats = {
    selected: rows.length,
    processed: 0,
    cacheHits: 0,
    llmRequests: 0,
    accepted: 0,
    degraded: 0,
    rejected: 0,
    failed: 0,
    costUsd: 0,
    stoppedByBudget: false,
  };

  for (const row of rows) {
    if (opts.limit !== undefined && stats.processed >= opts.limit) break;
    const source = getSourceDefinition(row.source_slug);
    // Profile selection uses the primary (first) declared category.
    const fallbackProfile = normalizationProfileForCategory(row.ingest_category);
    const profile = getNormalizationProfile(source?.normalizationProfile ?? fallbackProfile);
    const categorySlugs = resolveCategorySlugs(
      validSlugs,
      row.ingest_categories,
      row.ingest_category,
    );
    const captured = deterministicInput(row);
    const deterministic = buildDeterministicFacts(captured);
    const packet = requestPacket(row, profile.id, deterministic, categorySlugs);
    const inputHash = stableHash({
      rawContentHash: row.raw_content_hash,
      packet,
      normalizerVersion: NORMALIZER_VERSION,
      promptVersion: PROMPT_VERSION,
      schemaVersion: SCHEMA_VERSION,
      profileVersion: profile.version,
      examplesVersion: EXAMPLES_VERSION,
      model: ingestConfig.llm.model,
      llmMode: opts.noLlm ? "deterministic_only" : "deepseek",
      reprocessGeneration,
    });
    const jobId = await startJob(db, row, inputHash, opts.runId);

    try {
      if (!opts.reprocess) {
        const cached = await loadCached(db, row.id, inputHash);
        if (cached) {
          await activateNormalization(
            db,
            row,
            cached.id,
            inputHash,
            cached.resolved,
            opts.shadow || (opts.noLlm && row.active_normalization_id !== null),
          );
          stats.cacheHits++;
          stats.processed++;
          stats[cached.resolved.status]++;
          await finishJob(db, jobId, "succeeded", cached.id);
          console.log(
            `normalize ok cached ${row.source_record_id}${row.name ? ` "${row.name.replace(/"/g, "'")}"` : ""} (${cached.resolved.status})`,
          );
          continue;
        }
      }

      if (
        opts.maxRequests !== undefined &&
        stats.llmRequests >= opts.maxRequests &&
        deterministic.hardIsPoi !== false &&
        !opts.noLlm
      ) {
        await finishJob(db, jobId, "retryable", undefined, new Error("LLM request budget reached"));
        stats.stoppedByBudget = true;
        break;
      }
      if (
        opts.maxCostUsd !== undefined &&
        stats.costUsd >= opts.maxCostUsd &&
        deterministic.hardIsPoi !== false &&
        !opts.noLlm
      ) {
        await finishJob(db, jobId, "retryable", undefined, new Error("LLM cost budget reached"));
        stats.stoppedByBudget = true;
        break;
      }

      let output: LlmNormalizationOutput | null = null;
      let requestId: string | null = null;
      if (!opts.noLlm && deterministic.hardIsPoi !== false) {
        const completion = await callNormalizer(
          db,
          row,
          inputHash,
          profile.id,
          profile.version,
          packet,
        );
        output = completion.output;
        requestId = completion.requestId;
        stats.llmRequests++;
        stats.costUsd += completion.result.usage.estimatedCost ?? 0;
      }
      const resolved = resolveNormalization({
        output,
        deterministic,
        captured,
        categorySlugs,
        profile,
      });
      const normalizationId = await insertNormalization(
        db,
        row,
        inputHash,
        requestId,
        resolved,
        output,
      );
      await activateNormalization(
        db,
        row,
        normalizationId,
        inputHash,
        resolved,
        opts.shadow || (opts.noLlm && row.active_normalization_id !== null),
      );
      await finishJob(
        db,
        jobId,
        resolved.status === "rejected" ? "succeeded" : "succeeded",
        normalizationId,
      );
      stats.processed++;
      stats[resolved.status]++;
      console.log(
        `normalize ok ${row.source_record_id}${row.name ? ` "${row.name.replace(/"/g, "'")}"` : ""} (${resolved.status})`,
      );
    } catch (error) {
      stats.failed++;
      stats.processed++;
      await db.query(
        `UPDATE research_pois SET normalization_state = 'failed' WHERE id = $1`,
        [row.id],
      );
      await finishJob(
        db,
        jobId,
        error instanceof LlmError && error.retryable ? "retryable" : "failed",
        undefined,
        error,
      );
      console.log(
        `normalize failed ${row.source_record_id}${row.name ? ` "${row.name.replace(/"/g, "'")}"` : ""} (${(error as Error).message.slice(0, 500)})`,
      );
    }
  }
  return stats;
}
