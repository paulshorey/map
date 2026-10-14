import { hostname, userInfo } from "node:os";
import { getDb } from "../../lib/db/postgres.js";
import { inspectControl } from "./control.js";
import { resolveIssue } from "../../sql/ingestion-issues.js";
const args = process.argv.slice(2);
let id = "",
  action = "",
  reason = "",
  maintenanceToken = "",
  run: string | undefined;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json" || arg === "resolve" || arg === "list") continue;
  if (
    ![
      "--issue",
      "--action",
      "--reason",
      "--run",
      "--maintenance-token",
    ].includes(arg!) ||
    !args[i + 1]
  )
    throw new Error(
      "Usage: ingest:issues [list --run UUID|resolve --issue UUID --action retry|exclude --reason TEXT] [--json]",
    );
  const val = args[++i]!;
  if (arg === "--issue") id = val;
  else if (arg === "--action") action = val;
  else if (arg === "--reason") reason = val;
  else if (arg === "--maintenance-token") maintenanceToken = val;
  else run = val;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
if ((id && !uuid.test(id)) || (run && !uuid.test(run)))
  throw new Error("Issue/run must be a UUID");
const db = getDb();
try {
  if (args[0] === "resolve") {
    if (
      !id ||
      !["retry", "exclude"].includes(action) ||
      !reason.trim() ||
      !uuid.test(maintenanceToken)
    )
      throw new Error(
        "Resolution needs --issue, --action retry|exclude, --reason and the owned --maintenance-token",
      );
    const control = await inspectControl(db);
    if (!control.maintenance.maintenance || !control.quiescent)
      throw new Error(
        "Enter owned maintenance and confirm quiescence before record repair",
      );
    console.log(
      JSON.stringify(
        await resolveIssue(
          db,
          id,
          action as "retry" | "exclude",
          reason,
          `${userInfo().username}@${hostname()}:${process.pid}`,
          maintenanceToken,
        ),
        null,
        2,
      ),
    );
  } else
    console.log(
      JSON.stringify(
        (
          await db.query(
            "SELECT * FROM research_ingest_issues WHERE ($1::uuid IS NULL OR run_id=$1) ORDER BY last_seen_at DESC LIMIT 20",
            [run ?? null],
          )
        ).rows,
        null,
        2,
      ),
    );
} finally {
  await db.end();
}
