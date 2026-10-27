/** Bounded, read-only policy preview. Does not activate artifacts or call providers. */
import { getDb } from "../../lib/db/postgres.js";
import { locationAssessmentInputSql } from "../../sql/location-assessments.js";
import { assessLocation, type AssessmentInput } from "./location-assessment.js";
import { precisionDiagnostics } from "./precision-diagnostics.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--records")
  throw new Error(
    "Usage: ingest:location-assess --records <UUID,UUID,...> (1–100 records, read only)",
  );
const ids = [...new Set(args[1]!.split(","))];
if (
  !ids.length ||
  ids.length > 100 ||
  ids.some(
    (id) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      ),
  )
)
  throw new Error("Supply 1–100 explicit research POI UUIDs");
const db = getDb(),
  client = await db.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query("SET LOCAL lock_timeout='5s'");
  const { rows } = await client.query<{
    id: string;
    source: string;
    source_record_id: string;
    input: AssessmentInput | null;
  }>(
    `SELECT rp.id,rs.slug AS source,rp.source_record_id,${locationAssessmentInputSql()} AS input
      FROM research_pois rp JOIN research_sources rs ON rs.id=rp.source_id WHERE rp.id=ANY($1::uuid[]) ORDER BY rp.id`,
    [ids],
  );
  const results = rows.map(({ input, ...identity }) => ({
    ...identity,
    assessment: input ? assessLocation(input) : null,
    precision_diagnostics: precisionDiagnostics(input),
    ...(input ? {} : { reason: "missing_active_input_lineage" }),
  }));
  console.log(
    JSON.stringify(
      {
        policy_preview: true,
        writes: 0,
        provider_calls: 0,
        selected: ids.length,
        found: rows.length,
        missing_ids: ids.filter((id) => !rows.some((r) => r.id === id)),
        results,
      },
      null,
      2,
    ),
  );
  await client.query("COMMIT");
} finally {
  client.release();
  await db.end();
}
