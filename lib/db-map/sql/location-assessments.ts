import type { Pool, PoolClient } from "pg";
import {
  assessLocation,
  LOCATION_ASSESSMENT_VERSION,
  type AssessmentInput,
  type LocationAssessment,
} from "../scripts/ingest/location-assessment.js";
import { LOCATION_VERSION } from "../scripts/ingest/location.js";

/** One snapshot expression for activation, cache checks and publication fencing. */
export function locationAssessmentInputSql(alias = "rp"): string {
  return `(SELECT jsonb_build_object(
    'observation_id',o.id,'normalization_id',n.id,'geocode_id',g.id,
    'captured',o.captured,'point',jsonb_build_object('lat',${alias}.lat,'lng',${alias}.lng),
    'coordinate_source',${alias}.coordinate_source,'coordinate_precision',${alias}.coordinate_precision,
    'projection_location',jsonb_build_object('country_code',${alias}.country_code,'city',${alias}.city,'region',${alias}.region,'address',${alias}.address),
    'geocoder_version',g.provider_version,'validation',g.validation)
    FROM research_poi_normalizations n JOIN research_poi_observations o ON o.id=n.observation_id
    LEFT JOIN research_poi_geocodes g ON g.id=${alias}.active_geocode_id AND g.normalization_id=n.id AND g.status='resolved'
      AND g.lat IS NOT DISTINCT FROM ${alias}.lat AND g.lng IS NOT DISTINCT FROM ${alias}.lng
    WHERE n.id=${alias}.active_normalization_id AND n.research_poi_id=${alias}.id
      AND o.id=${alias}.active_observation_id AND o.research_poi_id=${alias}.id)`;
}
/** Diagnostic only. Ingestion and publication do not require this status. */
export function acceptedLocationSql(alias = "rp"): string {
  return `EXISTS(SELECT 1 FROM research_poi_location_assessments la
    WHERE la.id=${alias}.active_location_assessment_id AND la.research_poi_id=${alias}.id
      AND la.policy_version='${LOCATION_ASSESSMENT_VERSION}' AND la.status='accepted'
      AND la.input_snapshot=${locationAssessmentInputSql(alias)})`;
}

/** Current advisory assessment for these inputs, whatever its status. */
export function currentLocationAssessmentSql(alias = "rp"): string {
  return `EXISTS(SELECT 1 FROM research_poi_location_assessments la
    WHERE la.id=${alias}.active_location_assessment_id AND la.research_poi_id=${alias}.id
      AND la.policy_version='${LOCATION_ASSESSMENT_VERSION}'
      AND la.input_snapshot=${locationAssessmentInputSql(alias)})`;
}

/** Keep the last serving snapshot only while a live member awaits any replacement membership. */
export function publicationAwaitingLocationSql(alias = "cp"): string {
  return `EXISTS(SELECT 1 FROM canonical_poi_builds held
    JOIN canonical_poi_build_inputs hi ON hi.build_id=held.id
    JOIN research_pois rp ON rp.id=hi.research_poi_id
    WHERE held.id=${alias}.active_build_id AND held.status='accepted' AND rp.is_poi AND rp.retired_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM research_canonical_memberships m
        WHERE m.research_poi_id=rp.id AND m.active))`;
}
export interface StoredLocationAssessment extends LocationAssessment {
  id: string;
}

/** Persist a selected assessment independently of task success; no providers or publication. */
export async function assessLocationRecord(db: Pool, researchId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const assessment = await ensureLocationAssessment(client, researchId);
    await client.query("COMMIT");
    return assessment;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Caller owns the transaction. Lock the projection before reading and activating immutable evidence. */
export async function ensureLocationAssessment(
  client: PoolClient,
  researchId: string,
): Promise<StoredLocationAssessment> {
  await client.query("SELECT id FROM research_pois WHERE id=$1 FOR UPDATE", [
    researchId,
  ]);
  const { rows } = await client.query<{ input: AssessmentInput | null }>(
    `SELECT ${locationAssessmentInputSql()} AS input FROM research_pois rp WHERE rp.id=$1`,
    [researchId],
  );
  const input = rows[0]?.input;
  if (!input?.observation_id || !input.normalization_id)
    throw Object.assign(
      new Error("Location assessment input lineage mismatch"),
      { code: "lineage_invalid" },
    );
  const assessment = assessLocation(input);
  const stored = await client.query<{ id: string }>(
    `INSERT INTO research_poi_location_assessments(research_poi_id,observation_id,normalization_id,geocode_id,
      policy_version,input_hash,input_snapshot,status,accepted_kind,accepted_point,reasons,evidence)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(research_poi_id,policy_version,input_hash) DO NOTHING RETURNING id`,
    [
      researchId,
      input.observation_id,
      input.normalization_id,
      input.geocode_id,
      assessment.policy_version,
      assessment.input_hash,
      input,
      assessment.status,
      assessment.accepted_kind,
      assessment.accepted_point,
      assessment.reasons,
      assessment.evidence,
    ],
  );
  const id =
    stored.rows[0]?.id ??
    (
      await client.query<{ id: string }>(
        "SELECT id FROM research_poi_location_assessments WHERE research_poi_id=$1 AND policy_version=$2 AND input_hash=$3",
        [researchId, assessment.policy_version, assessment.input_hash],
      )
    ).rows[0]!.id;
  await client.query(
    "UPDATE research_pois SET active_location_assessment_id=$2 WHERE id=$1",
    [researchId, id],
  );
  return { ...assessment, id };
}

/** Derived location-review flag from stored evidence, so existing records need no backfill.
 * `missing_location`: no plottable point. `coarse_location_only`: every candidate is
 * city, region or country precision. Enrichment slots count only while bound to the active
 * normalization and current point and at least one is present; otherwise (a stale enrichment
 * or a retained legacy point) the current columns decide. Advisory only; never a matching or
 * publication gate. */
export function locationReviewSql(alias = "rp"): string {
  const enrichment = `${alias}.attributes->'location_enrichment'`;
  const e = `${enrichment}->'coordinate_evidence'`;
  const bound = `(${enrichment}->>'version'='${LOCATION_VERSION}'
      AND ${enrichment}->>'normalization_id'=${alias}.active_normalization_id::text
      AND ${enrichment}->'point'=jsonb_build_object('lat',${alias}.lat,'lng',${alias}.lng)
      AND jsonb_typeof(${e})='object')`;
  const present = (slot: string) => `jsonb_typeof(${e}->'${slot}')='object'`;
  const precise = (slot: string) =>
    `COALESCE(${e}->'${slot}'->>'precision','')='point'`;
  // A bound enrichment with no slots (a legacy point whose new lookup missed) defers to the columns.
  return `(CASE
    WHEN COALESCE(${bound},false) AND (${present("source_coordinates")} OR ${present("inferred_coordinates")}) THEN
      CASE WHEN NOT (${precise("source_coordinates")} OR ${precise("inferred_coordinates")}) THEN 'coarse_location_only' END
    WHEN ${alias}.lat IS NULL OR ${alias}.lng IS NULL THEN 'missing_location'
    WHEN COALESCE(${alias}.coordinate_precision,'point')<>'point' THEN 'coarse_location_only'
  END)`;
}
