import type { Pool } from "pg";
import { rebuildCanonicalPoi } from "../scripts/ingest/merge.js";
import { PIPELINE_VERSIONS } from "../scripts/ingest/pipeline-versions.js";
export async function resolveIssue(
  db: Pool,
  id: string,
  action: "retry" | "exclude",
  reason: string,
  actor: string,
  maintenanceToken: string,
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const gate = (
      await client.query(
        "SELECT * FROM research_ingest_control WHERE singleton FOR UPDATE",
      )
    ).rows[0];
    const drain = (
      await client.query(
        "SELECT pg_try_advisory_xact_lock(91832,1) AS acquired",
      )
    ).rows[0];
    if (
      !gate.maintenance ||
      !drain.acquired ||
      gate.maintenance_token !== maintenanceToken
    )
      throw new Error(
        "Quiescent maintenance is required for record resolution",
      );
    const issue = (
      await client.query(
        "SELECT * FROM research_ingest_issues WHERE id=$1 FOR UPDATE",
        [id],
      )
    ).rows[0];
    if (!issue || issue.scope !== "record" || !issue.source_record_id)
      throw new Error("Only an existing record issue can be resolved here");
    const item = (
      await client.query(
        `SELECT i.*,rp.canonical_poi_id,rp.active_observation_id FROM research_ingest_run_items i
    JOIN research_pois rp ON rp.id=i.research_poi_id WHERE i.run_id=$1 AND i.source_record_id=$2 FOR UPDATE OF rp`,
        [issue.run_id, issue.source_record_id],
      )
    ).rows[0];
    if (!item || item.active_observation_id !== item.observation_id)
      throw new Error("Pinned observation changed; exclusion/repair refused");
    if (action === "retry") {
      if (issue.status === "excluded")
        throw new Error(
          "Excluded records require a deliberate new reviewed run; do not undo retirement by retrying",
        );
      await client.query(
        `UPDATE research_ingest_tasks SET state='pending',claim_token=NULL,execution_id=NULL,output=NULL,updated_at=now()
      WHERE run_id=$1 AND source_record_id=$2 AND rank>=(SELECT rank FROM research_ingest_tasks WHERE run_id=$1 AND source_record_id=$2 AND stage=$3)`,
        [issue.run_id, issue.source_record_id, issue.stage],
      );
      await client.query(
        "UPDATE research_ingest_issues SET status='resolved',last_seen_at=now() WHERE id=$1",
        [id],
      );
      await client.query(
        "DELETE FROM research_ingest_record_verifications WHERE run_id=$1 AND source_record_id=$2",
        [issue.run_id, issue.source_record_id],
      );
    } else {
      await client.query(
        `UPDATE research_pois SET retired_at=now() WHERE id=$1`,
        [item.research_poi_id],
      );
      await client.query(
        `UPDATE research_canonical_memberships SET active=false,retired_at=now(),retirement_reason='operator_excluded' WHERE research_poi_id=$1 AND active`,
        [item.research_poi_id],
      );
      if (item.canonical_poi_id)
        await rebuildCanonicalPoi(client, item.canonical_poi_id, {
          noLlm: true,
        });
      const execution = (
        await client.query(
          "SELECT id FROM research_ingest_executions WHERE run_id=$1 ORDER BY started_at DESC LIMIT 1",
          [issue.run_id],
        )
      ).rows[0];
      const output = {
        status: "skipped",
        reason: "operator_excluded",
        issue_id: id,
        actor,
        explanation: reason,
      };
      await client.query(
        `UPDATE research_ingest_tasks SET state='skipped',output=$3,finished_at=now(),updated_at=now() WHERE run_id=$1 AND source_record_id=$2`,
        [issue.run_id, issue.source_record_id, JSON.stringify(output)],
      );
      await client.query(
        `INSERT INTO research_ingest_record_verifications(run_id,source_record_id,execution_id,observation_id,output,pipeline_versions,outcome)
     VALUES($1,$2,$3,$4,$5,$6,'operator_excluded') ON CONFLICT(run_id,source_record_id) DO UPDATE SET outcome='operator_excluded',output=EXCLUDED.output,verified_at=now()`,
        [
          issue.run_id,
          issue.source_record_id,
          execution.id,
          item.observation_id,
          JSON.stringify(output),
          JSON.stringify(PIPELINE_VERSIONS),
        ],
      );
      await client.query(
        "UPDATE research_ingest_issues SET status='excluded',last_seen_at=now() WHERE run_id=$1 AND source_record_id=$2",
        [issue.run_id, issue.source_record_id],
      );
    }
    await client.query(
      "INSERT INTO research_ingest_issue_events(issue_id,actor,action,reason) VALUES($1,$2,$3,$4)",
      [id, actor, action, reason],
    );
    await client.query("COMMIT");
    return {
      id,
      action,
      reason,
      run_id: issue.run_id,
      record: issue.source_record_id,
      resume_args: ["--resume", issue.run_id, "--unlimited"],
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
