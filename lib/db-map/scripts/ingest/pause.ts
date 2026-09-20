import { getDb } from "../../lib/db/postgres.js";

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 2 ||
    args[0] !== "--run" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(args[1]!)
  ) {
    throw new Error("Usage: ingest:pause --run <uuid>");
  }
  const db = getDb();
  try {
    const { rowCount } = await db.query(
      `UPDATE research_ingest_runs SET stop_requested=true
      WHERE id=$1 AND managed AND status='running'`,
      [args[1]],
    );
    if (!rowCount)
      throw new Error(
        "No running managed run with this ID; inspect ingest:status",
      );
    console.log(
      `Pause requested for ${args[1]}; the worker checks every five seconds and finishes its current record.`,
    );
  } finally {
    await db.end();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
