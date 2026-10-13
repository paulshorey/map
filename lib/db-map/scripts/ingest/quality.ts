import { hostname, userInfo } from "node:os";
import { getDb } from "../../lib/db/postgres.js";
import { getInventory } from "../../sql/ingestion-inventory.js";
import { PIPELINE_VERSIONS } from "./pipeline-versions.js";
const args = process.argv.slice(2);
const opts: Record<string, string> = {};
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--json" || a === "review") continue;
  if (
    !["--file", "--decision", "--reason", "--records"].includes(a) ||
    !args[i + 1]
  )
    throw new Error(
      "Usage: ingest:quality review --file PATH --decision accepted|needs_work --records ID,ID --reason TEXT",
    );
  opts[a] = args[++i]!;
}
if (
  !opts["--file"] ||
  !["accepted", "needs_work"].includes(opts["--decision"] ?? "") ||
  !opts["--reason"]?.trim()
)
  throw new Error("Quality review requires explicit file, decision and reason");
const samples = [
  ...new Set((opts["--records"] ?? "").split(",").filter(Boolean)),
];
if (samples.length < 1 || samples.length > 20)
  throw new Error("Provide 1..20 inspected source record IDs");
const db = getDb();
try {
  const inventory = await getInventory(db, { file: opts["--file"] });
  const f = inventory.files[0];
  if (!f?.file_sha256) throw new Error("File missing from current inventory");
  const found = (
    await db.query(
      `SELECT DISTINCT rr.source_record_id FROM research_ingest_run_records rr JOIN research_source_file_versions v ON v.id=rr.source_file_version_id
   JOIN research_source_files sf ON sf.id=v.source_file_id WHERE sf.logical_path=$1 AND v.file_sha256=$2 AND rr.source_record_id=ANY($3::text[])`,
      [f.logical_path, f.file_sha256, samples],
    )
  ).rows;
  if (found.length !== samples.length)
    throw new Error("Quality evidence must reference current capture records");
  const row = (
    await db.query(
      `INSERT INTO research_ingest_quality_reviews(inventory_id,file_sha256,pipeline_versions,actor,decision,reason,sample_records)
   VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,decision,reviewed_at`,
      [
        f.id,
        f.file_sha256,
        JSON.stringify(PIPELINE_VERSIONS),
        `${userInfo().username}@${hostname()}:${process.pid}`,
        opts["--decision"],
        opts["--reason"],
        samples,
      ],
    )
  ).rows[0];
  console.log(
    JSON.stringify(
      {
        ...row,
        file: f.logical_path,
        sample_records: samples,
        meaning:
          "Sampled quality review, separate from structural verification",
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
