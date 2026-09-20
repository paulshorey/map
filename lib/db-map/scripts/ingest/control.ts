import { execFile } from "node:child_process";
import { hostname, userInfo } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { Pool } from "pg";
import { getDb } from "../../lib/db/postgres.js";
import {
  changeMaintenance,
  controlState,
  requestStops,
  workerEvidence,
  reconcileAbsentExecution,
} from "../../sql/ingestion-control.js";

const actor = `${userInfo().username}@${hostname()}:${process.pid}`;
const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const USAGE = `ingest:control list [--json]
ingest:control stop (--run <uuid> | --all) [--wait-seconds 30] [--json]
ingest:control maintenance enter --reason <text> [--wait-seconds 30] [--json]
ingest:control maintenance exit --token <uuid> [--json]
ingest:control reconcile --execution <uuid> [--json]

Maintenance persists until explicitly exited with its token. Timeout exits 2 and leaves
pause requests and maintenance in place; it never kills a worker or claims it stopped.
Use ingest:run / --resume to start workers after reopening admission.`;

export function parseControlArgs(argv: string[]) {
  const args = [...argv];
  const command = args.shift() ?? "list";
  const action = command === "maintenance" ? args.shift() : undefined;
  if (command === "--help")
    return { command: "help", waitSeconds: 30, json: false };
  if (
    !["list", "stop", "maintenance", "reconcile"].includes(command) ||
    (command === "maintenance" && !["enter", "exit"].includes(action ?? ""))
  )
    throw new Error(USAGE);
  const opts: {
    command: string;
    action?: string;
    json: boolean;
    all?: boolean;
    run?: string;
    execution?: string;
    reason?: string;
    token?: string;
    waitSeconds: number;
  } = { command, action, json: false, waitSeconds: 30 };
  const allowed =
    command === "list"
      ? []
      : command === "stop"
        ? ["--run", "--all", "--wait-seconds"]
        : command === "reconcile"
          ? ["--execution"]
          : action === "enter"
            ? ["--reason", "--wait-seconds"]
            : ["--token"];
  while (args.length) {
    const flag = args.shift()!;
    if (flag === "--json") {
      opts.json = true;
      continue;
    }
    if (!allowed.includes(flag))
      throw new Error(`Invalid option ${flag}\n${USAGE}`);
    if (flag === "--all") {
      opts.all = true;
      continue;
    }
    const value = args.shift();
    if (!value || value.startsWith("--"))
      throw new Error(`Missing value for ${flag}`);
    if (flag === "--wait-seconds") opts.waitSeconds = Number(value);
    else if (flag === "--run") opts.run = value;
    else if (flag === "--execution") opts.execution = value;
    else if (flag === "--token") opts.token = value;
    else opts.reason = value;
  }
  if (
    !Number.isSafeInteger(opts.waitSeconds) ||
    opts.waitSeconds < 0 ||
    opts.waitSeconds > 60
  )
    throw new Error(
      "--wait-seconds must be 0..60; inspect/retry after a timeout",
    );
  for (const id of [opts.run, opts.execution, opts.token])
    if (id && !UUID.test(id)) throw new Error("Expected a UUID");
  if (command === "stop" && Boolean(opts.run) === Boolean(opts.all))
    throw new Error("Choose exactly one of --run or --all");
  if (command === "reconcile" && !opts.execution)
    throw new Error("--execution is required");
  if (
    command === "maintenance" &&
    (action === "enter" ? !opts.reason?.trim() : !opts.token)
  )
    throw new Error(
      action === "enter" ? "--reason is required" : "--token is required",
    );
  return opts;
}

export function localPidState(host: string, pid: number) {
  if (host !== hostname()) return "remote_unknown";
  try {
    process.kill(pid, 0);
    return "present_identity_unverified";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? "absent"
      : "unknown";
  }
}

/** Candidate discovery only: never use command text or a stored PID as kill authorization. */
export function scriptProcesses(output: string) {
  return output.split("\n").flatMap((line) => {
    const row = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!row || !/^(?:\S*\/)?(?:node|tsx|pnpm)(?:\s|$)/.test(row[3]!))
      return [];
    const script = row[3]!.match(
      /(?:^|\s)(?:\S*\/)?scripts\/(ingest\/[\w/-]+|import-[\w-]+)\.(?:ts|js)(?:\s|$)/,
    )?.[1];
    if (
      !script ||
      /(?:\.test|golden)/.test(script) ||
      /ingest\/(?:control|pause|status|report|trace|verify|inventory|test-[\w-]+)$/.test(
        script,
      )
    )
      return [];
    return [{ pid: Number(row[1]), ppid: Number(row[2]), script }];
  });
}

export async function inspectControl(db: Pool) {
  const state = await controlState(db);
  const evidence = await workerEvidence(db);
  const workers = evidence.workers.map((w) => ({
    ...w,
    local_process: localPidState(w.host, w.pid),
    source_locked: evidence.sourceLocks.some((l) => l.source === w.source),
  }));
  let localProcesses: ReturnType<typeof scriptProcesses> = [];
  let processScanError: string | null = null;
  try {
    const { stdout } = await promisify(execFile)(
      "ps",
      ["-axo", "pid=,ppid=,args="],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    localProcesses = scriptProcesses(stdout);
  } catch {
    processScanError =
      "Local process inventory unavailable; inspect host processes before editing";
  }
  const quiescent =
    !processScanError &&
    !evidence.admitted.length &&
    !evidence.sourceLocks.length &&
    !localProcesses.length &&
    workers.every((w) => w.local_process === "absent");
  return {
    inspected_at: new Date().toISOString(),
    host: hostname(),
    maintenance: state,
    quiescent,
    workers,
    source_locks: evidence.sourceLocks,
    admitted_workers: evidence.admitted,
    local_script_processes: localProcesses,
    process_scan_error: processScanError,
    limitations:
      "Managed locks cover all connected hosts. Local process discovery is heuristic; remote standalone scripts are not registered. PID presence does not verify identity. Quiescence is a snapshot; maintenance blocks new managed admission.",
  };
}

export async function waitForStop(db: Pool, seconds: number, run?: string) {
  // Retain the last PID after it writes a terminal status: finalization is not process exit.
  const target = run
    ? (
        await db.query(
          `SELECT e.host,e.pid,s.slug AS source FROM research_ingest_executions e
    JOIN research_ingest_runs r ON r.id=e.run_id JOIN research_sources s ON s.id=r.source_id
    WHERE e.run_id=$1 ORDER BY e.started_at DESC LIMIT 1`,
          [run],
        )
      ).rows[0]
    : undefined;
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const snapshot = await inspectControl(db);
    const workers = snapshot.workers.filter((w) => w.run_id === run);
    const stopped = run
      ? workers.every(
          (w) => w.local_process === "absent" && !w.source_locked,
        ) &&
        (!target ||
          (localPidState(target.host, target.pid) === "absent" &&
            !snapshot.source_locks.some((l) => l.source === target.source)))
      : snapshot.quiescent;
    if (stopped || Date.now() >= deadline) return { stopped, snapshot };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))),
    );
  }
}

function print(
  result: Awaited<ReturnType<typeof inspectControl>> & {
    stop_confirmed?: boolean;
    stop_scope?: string;
  },
  json: boolean,
) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `Maintenance: ${result.maintenance.maintenance ? "ON" : "off"}; quiescent: ${result.quiescent}`,
  );
  if (result.stop_confirmed !== undefined)
    console.log(
      `Stop confirmed (${result.stop_scope}): ${result.stop_confirmed}`,
    );
  if (result.maintenance.maintenance)
    console.log(
      `Reason: ${result.maintenance.reason}\nOwner: ${result.maintenance.actor}\nExit token: ${result.maintenance.maintenance_token}`,
    );
  for (const w of result.workers)
    console.log(
      `${w.run_id} / ${w.execution_id}: ${w.source} ${w.current_stage}; recorded=${w.status}; ${w.host}:${w.pid} ${w.local_process}; source lock=${w.source_locked}; pause=${w.stop_requested}`,
    );
  for (const p of result.local_script_processes)
    console.log(
      `Local script candidate: PID ${p.pid}, parent ${p.ppid}, ${p.script}`,
    );
  console.log(
    `Source locks: ${result.source_locks.length}; admitted workers: ${result.admitted_workers.length}`,
  );
  if (result.process_scan_error) console.log(result.process_scan_error);
  console.log(result.limitations);
}

async function main() {
  const opts = parseControlArgs(process.argv.slice(2));
  if (opts.command === "help") {
    console.log(USAGE);
    return;
  }
  const db = getDb();
  try {
    if (opts.command === "stop") await requestStops(db, opts.run, actor);
    if (opts.command === "maintenance")
      await changeMaintenance(
        db,
        opts.action === "enter",
        actor,
        opts.reason,
        opts.token,
      );
    if (opts.command === "reconcile") {
      const snapshot = await inspectControl(db);
      const worker = snapshot.workers.find(
        (w) => w.execution_id === opts.execution,
      );
      if (!snapshot.quiescent || !worker || worker.local_process !== "absent")
        throw new Error(
          "Reconcile requires quiescence and a recorded local worker whose PID is absent; remote/unknown/live PIDs are not eligible",
        );
      await reconcileAbsentExecution(db, opts.execution!, actor);
    }
    if (
      opts.command === "stop" ||
      (opts.command === "maintenance" && opts.action === "enter")
    ) {
      const result = await waitForStop(db, opts.waitSeconds, opts.run);
      print(
        {
          ...result.snapshot,
          stop_confirmed: result.stopped,
          stop_scope: opts.run ?? "all",
        },
        opts.json,
      );
      if (!result.stopped) {
        console.error(
          "Stop not confirmed before timeout. Do not edit yet. Inspect workers; maintenance/pause requests remain in place.",
        );
        process.exitCode = 2;
      }
    } else print(await inspectControl(db), opts.json);
  } finally {
    await db.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
