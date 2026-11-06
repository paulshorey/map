/**
 * Sequential import queue: one full-file import at a time, in order, each through the
 * supervisor (`ingest:supervise watch`). Ordinary Node waiting; no model is invoked.
 *
 * - A file whose inventory coverage is already `complete` is skipped.
 * - The next file starts only after the previous one finished with outcome `succeeded` AND its
 *   inventory coverage is `complete` (whole-file verification, not exit code alone).
 * - A run that stops at the daily geocoding quota (`provider_daily_quota`) is resumed with the
 *   same run UUID after the quota resets (00:00 UTC). Twice in a row with no progress stops.
 * - Any other outcome stops the queue as `needs_attention`; nothing is retried blindly.
 * - Before each launch the pipeline must be quiescent and out of maintenance (waits up to 1 h).
 * - One queue worker at a time on any host: it holds a database advisory lock for its lifetime.
 *   A queue whose worker died (lock free) is reported interrupted; `resume` continues it.
 *
 * Usage:
 *   ingest:import-queue start --plan <plan.json>        # or: start -- <file>=<category> ...
 *   ingest:import-queue status [--queue <id>] [--json]  # latest queue by default
 *   ingest:import-queue list
 *   ingest:import-queue stop [--queue <id>] [--now]     # after the current file, or stop it now
 *   ingest:import-queue resume [--queue <id>]           # continue an interrupted/stopped queue
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { PoolClient } from "pg";
import { getDb, closeDb } from "../../lib/db/postgres.js";
import { getInventory } from "../../sql/ingestion-inventory.js";
import { inspectControl } from "./control.js";
import { atomicJson, jobPath, UUID } from "./supervisor-state.js";
import { queueItem } from "../../lib/ingestion/queue.js";
import {
  IMPORT_QUEUE_ENV,
  IMPORT_QUEUE_LOCK,
  INGEST_LOCK_NAMESPACE,
  importQueueActive,
} from "../../lib/ingestion/locks.js";

const PACKAGE = fileURLToPath(new URL("../../", import.meta.url));
const REPO = resolve(PACKAGE, "../..");
const SELF = fileURLToPath(import.meta.url);
const SUPERVISE = fileURLToPath(new URL("./supervise.ts", import.meta.url));
export const QUEUES = fileURLToPath(new URL("../../.ingest-queues/", import.meta.url));

export type EntryStatus =
  | "pending"
  | "running"
  | "waiting_quota"
  | "succeeded"
  | "skipped_complete"
  | "needs_attention"
  | "stopped";

export interface QueueEntry {
  file: string;
  category: string;
  status: EntryStatus;
  run_id: string | null;
  jobs: string[];
  quota_pauses: number;
  started_at: string | null;
  finished_at: string | null;
  outcome: string | null;
  reason: string | null;
  resets_at: string | null;
  coverage: string | null;
}

export interface QueueState {
  id: string;
  created_at: string;
  updated_at: string;
  host: string;
  pid: number | null;
  status: "queued" | "running" | "waiting" | "finished" | "stopped" | "needs_attention";
  message: string | null;
  current: number | null;
  entries: QueueEntry[];
}

const queuePath = (id: string, file = "state.json") => {
  if (!UUID.test(id)) throw new Error("Expected a queue UUID");
  return join(QUEUES, id, file);
};
export async function loadQueue(id: string): Promise<QueueState> {
  return JSON.parse(await readFile(queuePath(id), "utf8"));
}
async function saveQueue(q: QueueState) {
  q.updated_at = new Date().toISOString();
  await atomicJson(queuePath(q.id), q);
}
export async function listQueues(): Promise<QueueState[]> {
  const ids = await readdir(QUEUES).catch(() => [] as string[]);
  const queues = await Promise.all(
    ids.filter((id) => UUID.test(id)).map((id) => loadQueue(id).catch(() => null)),
  );
  return queues
    .filter((q): q is QueueState => !!q)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
const stopRequested = (id: string) =>
  access(queuePath(id, "stop.request")).then(
    () => true,
    () => false,
  );
const stopNowRequested = (id: string) =>
  readFile(queuePath(id, "stop.request"), "utf8").then(
    (text) => text.startsWith("now"),
    () => false,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Session advisory lock on a dedicated connection; held until the worker exits. */
async function acquireQueueLock(): Promise<PoolClient | null> {
  const client = await getDb().connect();
  const { rows } = await client.query("SELECT pg_try_advisory_lock($1, $2) AS ok", [
    INGEST_LOCK_NAMESPACE,
    IMPORT_QUEUE_LOCK,
  ]);
  if (rows[0]?.ok) return client;
  client.release();
  return null;
}

/** Whether any host's queue worker holds the lock right now (plain imports hold it shared). */
const queueLockHeld = () => importQueueActive(getDb());

/** Wait until `until`, waking every 30 s to honour a stop request. Returns false if stopped. */
async function waitUntil(id: string, until: number): Promise<boolean> {
  while (Date.now() < until) {
    if (await stopRequested(id)) return false;
    await sleep(Math.min(30_000, until - Date.now()));
  }
  return true;
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolve(REPO, file))) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * The file's inventory state for this entry's category. Coverage counts as `complete` only when
 * the capture on disk still has the scanned hash and the category matches the entry.
 */
async function fileState(entry: Pick<QueueEntry, "file" | "category">) {
  const inventory = (await getInventory(getDb(), { file: entry.file })) as {
    files: Array<Parameters<typeof queueItem>[0]>;
  };
  const row = inventory.files.find((f) => f.logical_path === entry.file) ?? null;
  if (!row) return { coverage: null, continuation: null };
  const item = queueItem(row);
  const sameCategory = row.category_slug === entry.category;
  const sameFile = !!row.file_sha256 && row.file_sha256 === (await sha256(entry.file).catch(() => null));
  return {
    coverage: !sameCategory
      ? `category_${row.category_slug ?? "unset"}`
      : !sameFile
        ? "changed_since_scan"
        : row.coverage,
    // An unfinished full-file run keeps its cohort and checkpoints: resume it, never restart.
    continuation: sameCategory && sameFile ? item.continuation_run_id : null,
  };
}

async function quotaResetsAt(runId: string): Promise<string | null> {
  const { rows } = await getDb().query(
    "SELECT counters->'providerQuota'->>'resets_at' AS resets_at FROM research_ingest_runs WHERE id=$1",
    [runId],
  );
  return rows[0]?.resets_at ?? null;
}

/** Quiescent and out of maintenance, waiting up to an hour (another operator may be working). */
async function admissionClear(id: string): Promise<string | null> {
  const deadline = Date.now() + 3600_000;
  for (;;) {
    const control = await inspectControl(getDb());
    const blocked = control.maintenance.maintenance
      ? `maintenance is on (${control.maintenance.reason ?? "no reason"})`
      : !control.quiescent
        ? "another ingestion worker, source lock or script is active"
        : null;
    if (!blocked) return null;
    if (Date.now() > deadline) return blocked;
    if (!(await waitUntil(id, Date.now() + 60_000))) return "stop requested";
  }
}

/** Run one supervised import in the foreground; the last JSON line is its terminal result. */
async function superviseWatch(q: QueueState, entry: QueueEntry, args: string[], log: string) {
  const out = await open(log, "a", 0o600);
  const child = spawn(process.execPath, ["--import", "tsx", SUPERVISE, "watch", "--", ...args], {
    cwd: PACKAGE,
    stdio: ["ignore", "pipe", out.fd],
    env: { ...process.env, [IMPORT_QUEUE_ENV]: q.id },
  });
  let result: Record<string, unknown> | null = null;
  // `stop --now` may arrive before the job id is known: forward it once the id is.
  let forwarded = false;
  const jobsBefore = entry.jobs.length;
  const forward = setInterval(() => {
    void (async () => {
      // Only the job this launch created (earlier attempts' jobs are terminal).
      const job = entry.jobs.length > jobsBefore ? entry.jobs.at(-1) : undefined;
      if (forwarded || !job || !(await stopNowRequested(q.id))) return;
      forwarded = true;
      await writeFile(jobPath(job, "stop.request"), new Date().toISOString(), { mode: 0o600 });
    })().catch(() => undefined);
  }, 5000);
  const lines = createInterface({ input: child.stdout! });
  for await (const line of lines) {
    await out.write(`${line}\n`);
    try {
      const value = JSON.parse(line);
      if (value?.event === "ingestion.started" && typeof value.job_id === "string") {
        entry.jobs.push(value.job_id);
        await saveQueue(q);
      } else if (value && typeof value === "object" && "outcome" in value) result = value;
    } catch {
      // Non-JSON output is kept in the log only.
    }
  }
  const code = await new Promise<number | null>((resolve) =>
    child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve),
  );
  clearInterval(forward);
  await out.close();
  return { code, result };
}

/** What to do after one supervised import. Pure, so the advancement rules are testable. */
export function classifyResult(r: {
  outcome: string;
  stopReason?: string;
  coverage: string | null;
  runId: string | null;
  quickQuotaPauses: number;
}):
  | { action: "advance" }
  | { action: "wait_quota" }
  | { action: "attention"; reason: string } {
  if (r.outcome === "succeeded")
    return r.coverage === "complete"
      ? { action: "advance" }
      : {
          action: "attention",
          reason: `Run succeeded but file coverage is ${r.coverage}; inspect before advancing`,
        };
  if (r.outcome === "waiting_budget" && r.stopReason === "provider_daily_quota" && r.runId)
    return r.quickQuotaPauses >= 2
      ? {
          action: "attention",
          reason: "Daily geocoding quota was exhausted again right after resuming; check ingest:quota",
        }
      : { action: "wait_quota" };
  return {
    action: "attention",
    reason:
      `Import ended as ${r.outcome}` +
      (r.stopReason ? ` (${r.stopReason})` : "") +
      "; diagnose it before resuming (no automatic retry)",
  };
}

export async function runQueue(id: string) {
  const q = await loadQueue(id);
  const lock = await acquireQueueLock();
  if (!lock) {
    q.status = "needs_attention";
    q.message =
      "The queue lock is taken: another import queue worker or a plain ingest:run is active (any host)";
    await saveQueue(q);
    await closeDb();
    return;
  }
  q.pid = process.pid;
  q.status = "running";
  q.message = null;
  await saveQueue(q);
  const log = queuePath(id, "queue.log");
  try {
    for (let i = 0; i < q.entries.length; i++) {
      const entry = q.entries[i]!;
      if (["succeeded", "skipped_complete"].includes(entry.status)) continue;
      q.current = i;
      let quickQuotaPauses = 0;
      for (;;) {
        if (await stopRequested(id)) {
          entry.status = "stopped";
          q.status = "stopped";
          q.message = "Stopped by operator request";
          return;
        }
        const state = await fileState(entry);
        entry.coverage = state.coverage;
        entry.run_id ??= state.continuation;
        if (entry.coverage === "complete") {
          if (entry.status === "pending") entry.status = "skipped_complete";
          else entry.status = "succeeded";
          entry.finished_at ??= new Date().toISOString();
          await saveQueue(q);
          break;
        }
        if (!entry.run_id && entry.coverage !== null && /^(changed_since_scan|category_)/.test(entry.coverage)) {
          entry.status = "needs_attention";
          entry.reason =
            entry.coverage === "changed_since_scan"
              ? "The capture changed since the last inventory scan: run ingest:inventory --refresh, then resume"
              : `The inventory classifies this file as ${entry.coverage.slice(9)}: reclassify it or fix the plan, then resume`;
          q.status = "needs_attention";
          q.message = `${entry.file}: ${entry.reason}`;
          return;
        }
        if (entry.coverage === null) {
          entry.status = "needs_attention";
          entry.reason = "The file is not in the inventory: run ingest:inventory --refresh, then resume";
          q.status = "needs_attention";
          q.message = `${entry.file}: ${entry.reason}`;
          return;
        }
        const blocked = await admissionClear(id);
        if (blocked) {
          entry.status = blocked === "stop requested" ? "stopped" : "needs_attention";
          entry.reason = `Not launched: ${blocked}`;
          q.status = entry.status === "stopped" ? "stopped" : "needs_attention";
          q.message = entry.reason;
          return;
        }
        const args = entry.run_id
          ? ["--resume", entry.run_id, "--unlimited"]
          : [entry.file, "--category", entry.category, "--unlimited"];
        entry.status = "running";
        entry.started_at ??= new Date().toISOString();
        entry.reason = null;
        await saveQueue(q);
        const launched = Date.now();
        const { code, result } = await superviseWatch(q, entry, args, log);
        const evidence = (result?.evidence ?? {}) as { stop_reason?: string; status?: string };
        entry.run_id = (result?.run_id as string | undefined) ?? entry.run_id;
        entry.outcome = (result?.outcome as string | undefined) ?? `exit_${code}`;
        if (entry.outcome === "waiting_budget" && evidence.stop_reason === "provider_daily_quota") {
          entry.quota_pauses++;
          // A pause within 5 minutes of launch made no real progress; twice means the quota is
          // being used elsewhere or the reset did not happen as expected.
          quickQuotaPauses = Date.now() - launched < 300_000 ? quickQuotaPauses + 1 : 0;
        }
        if (entry.outcome === "succeeded") entry.coverage = (await fileState(entry)).coverage;
        // An operator `stop --now` pauses the import: record it as a stop, not a failure.
        if (entry.outcome !== "succeeded" && (await stopRequested(id))) {
          entry.status = "stopped";
          entry.reason = `Stopped by operator request (run ${entry.run_id ?? "unknown"} can be resumed)`;
          q.status = "stopped";
          q.message = `${entry.file}: ${entry.reason}`;
          return;
        }
        const step = classifyResult({
          outcome: entry.outcome,
          stopReason: evidence.stop_reason,
          coverage: entry.coverage,
          runId: entry.run_id,
          quickQuotaPauses,
        });
        if (step.action === "advance") {
          entry.status = "succeeded";
          entry.finished_at = new Date().toISOString();
          await saveQueue(q);
          break;
        }
        if (step.action === "wait_quota") {
          const resets = await quotaResetsAt(entry.run_id!);
          const until = (resets ? Date.parse(resets) : Date.now() + 3600_000) + 120_000;
          entry.status = "waiting_quota";
          entry.resets_at = new Date(until).toISOString();
          entry.reason = "Daily geocoding quota reached; resuming the same run after the reset";
          q.status = "waiting";
          q.message = `${entry.file}: waiting for the geocoding quota reset (${entry.resets_at})`;
          await saveQueue(q);
          if (!(await waitUntil(id, until))) continue; // the loop top records the stop
          q.status = "running";
          q.message = null;
          continue;
        }
        entry.status = "needs_attention";
        entry.reason = step.reason;
        entry.finished_at = new Date().toISOString();
        q.status = "needs_attention";
        q.message = `${entry.file}: ${entry.reason}`;
        return;
      }
    }
    q.current = null;
    q.status = "finished";
    q.message = "Every file finished with verified complete coverage";
  } catch (error) {
    q.status = "needs_attention";
    q.message = `Queue worker error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    try {
      q.pid = null;
      await saveQueue(q);
    } finally {
      // Always free the global lock, even if the state file cannot be written.
      await lock
        .query("SELECT pg_advisory_unlock($1, $2)", [INGEST_LOCK_NAMESPACE, IMPORT_QUEUE_LOCK])
        .catch(() => undefined);
      lock.release();
      await closeDb();
    }
  }
}

/** Active-status queues whose worker is gone (no host holds the lock) become `stopped`. */
async function reconcileStale(): Promise<QueueState[]> {
  const queues = await listQueues();
  // A just-launched worker takes the lock within seconds: give `queued` a 2-minute grace.
  const starting = (q: QueueState) =>
    q.status === "queued" && Date.now() - Date.parse(q.updated_at) < 120_000;
  const active = queues.filter(
    (q) => ["queued", "running", "waiting"].includes(q.status) && !starting(q),
  );
  if (!active.length || (await queueLockHeld())) return queues;
  for (const q of active) {
    q.status = "stopped";
    q.message = `Interrupted: its worker${q.pid ? ` (pid ${q.pid} on ${q.host})` : ""} is gone. Resume it with ingest:import-queue resume --queue ${q.id}`;
    q.pid = null;
    for (const e of q.entries) if (["running", "waiting_quota"].includes(e.status)) e.status = "pending";
    await saveQueue(q);
  }
  return queues;
}

function spawnWorker(id: string) {
  return (async () => {
    const log = await open(queuePath(id, "worker.log"), "a", 0o600);
    const child = spawn(process.execPath, ["--import", "tsx", SELF, "worker", "--queue", id], {
      cwd: PACKAGE,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
    });
    child.unref();
    await log.close();
  })();
}

export function parseEntries(argv: string[]): Array<{ file: string; category: string }> {
  return argv.map((arg) => {
    const at = arg.lastIndexOf("=");
    if (at <= 0) throw new Error(`Expected <file>=<category>, got ${arg}`);
    return { file: arg.slice(0, at), category: arg.slice(at + 1) };
  });
}

function newEntry(e: { file: string; category: string }): QueueEntry {
  if (!e.file.startsWith("data/poi/")) throw new Error(`Capture paths start with data/poi/: ${e.file}`);
  if (!/^[a-z_]+$/.test(e.category)) throw new Error(`Invalid category: ${e.category}`);
  return {
    file: e.file,
    category: e.category,
    status: "pending",
    run_id: null,
    jobs: [],
    quota_pauses: 0,
    started_at: null,
    finished_at: null,
    outcome: null,
    reason: null,
    resets_at: null,
    coverage: null,
  };
}

/** The active queue if there is one, else the most recently created. */
export async function currentQueue(): Promise<QueueState | null> {
  const queues = await listQueues();
  return queues.find((q) => ["queued", "running", "waiting"].includes(q.status)) ?? queues[0] ?? null;
}

async function latestId(): Promise<string> {
  const latest = await currentQueue();
  if (!latest) throw new Error("No import queue exists");
  return latest.id;
}

function summary(q: QueueState) {
  const icon: Record<EntryStatus, string> = {
    pending: "·",
    running: "▶",
    waiting_quota: "⏸",
    succeeded: "✔",
    skipped_complete: "✔",
    needs_attention: "✖",
    stopped: "■",
  };
  return [
    `Queue ${q.id}: ${q.status}${q.message ? ` — ${q.message}` : ""}`,
    ...q.entries.map(
      (e) =>
        `  ${icon[e.status]} ${e.status.padEnd(16)} ${e.file} (${e.category})` +
        (e.run_id ? ` run ${e.run_id}` : "") +
        (e.resets_at && e.status === "waiting_quota" ? ` until ${e.resets_at}` : "") +
        (e.reason && e.status !== "waiting_quota" ? `\n      ${e.reason}` : ""),
    ),
  ].join("\n");
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const flag = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command === "worker") return runQueue(flag("--queue")!);
  if (command === "start") {
    const plan = flag("--plan");
    const dash = rest.indexOf("--");
    const entries = plan
      ? (JSON.parse(await readFile(resolve(REPO, plan), "utf8")).entries as Array<{ file: string; category: string }>)
      : parseEntries(dash >= 0 ? rest.slice(dash + 1) : []);
    if (!entries.length) throw new Error("No entries: pass --plan <file> or -- <file>=<category> ...");
    const running = (await reconcileStale()).find((q) => ["queued", "running", "waiting"].includes(q.status));
    if (running) throw new Error(`Queue ${running.id} is already ${running.status}; stop it first`);
    if (await queueLockHeld())
      throw new Error("An import queue worker is running on another host; stop it first");
    const q: QueueState = {
      id: randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      host: hostname(),
      pid: null,
      status: "queued",
      message: null,
      current: null,
      entries: entries.map(newEntry),
    };
    await mkdir(join(QUEUES, q.id), { recursive: true, mode: 0o700 });
    await saveQueue(q);
    await spawnWorker(q.id);
    await closeDb();
    console.log(
      `Started import queue ${q.id} with ${q.entries.length} file(s).\n` +
        `Status: pnpm --silent --filter @lib/db-map ingest:import-queue status\n` +
        `Stop after the current file: pnpm --silent --filter @lib/db-map ingest:import-queue stop`,
    );
    return;
  }
  if (command === "resume") {
    await reconcileStale();
    const q = await loadQueue(flag("--queue") ?? (await latestId()));
    if (["queued", "running", "waiting"].includes(q.status))
      throw new Error(`Queue ${q.id} is already ${q.status}`);
    if (await queueLockHeld()) throw new Error("An import queue worker is running; stop it first");
    await rm(queuePath(q.id, "stop.request"), { force: true });
    for (const e of q.entries) if (["stopped", "needs_attention"].includes(e.status)) e.status = "pending";
    q.status = "queued";
    q.message = null;
    await saveQueue(q);
    await spawnWorker(q.id);
    await closeDb();
    console.log(`Resumed import queue ${q.id}; finished files are skipped, unfinished runs resume.`);
    return;
  }
  if (command === "list") {
    await reconcileStale().catch(() => undefined);
    await closeDb();
    for (const q of await listQueues())
      console.log(`${q.id} ${q.status.padEnd(15)} ${q.created_at} ${q.entries.length} file(s)`);
    return;
  }
  if (command === "status") {
    await reconcileStale().catch(() => undefined);
    await closeDb();
    const q = await loadQueue(flag("--queue") ?? (await latestId()));
    console.log(rest.includes("--json") ? JSON.stringify(q, null, 2) : summary(q));
    return;
  }
  if (command === "stop") {
    const q = await loadQueue(flag("--queue") ?? (await latestId()));
    const now = rest.includes("--now");
    await writeFile(queuePath(q.id, "stop.request"), `${now ? "now" : "next"} ${new Date().toISOString()}`, {
      mode: 0o600,
    });
    const current = q.current !== null ? q.entries[q.current] : null;
    const job = current?.status === "running" ? current.jobs.at(-1) : undefined;
    if (now && job) {
      await writeFile(jobPath(job, "stop.request"), new Date().toISOString(), { mode: 0o600 });
      console.log(`Stop requested for queue ${q.id} and its current job ${job} (graceful).`);
    } else
      console.log(
        now
          ? `Stop requested for queue ${q.id}; its current import is stopped gracefully as soon as it starts.`
          : `Stop requested for queue ${q.id}; it stops before the next launch.`,
      );
    return;
  }
  console.log(
    "Usage: ingest:import-queue start --plan <plan.json> | start -- <file>=<category> ...\n" +
      "       ingest:import-queue status [--queue <id>] [--json] | list | stop [--queue <id>] [--now]\n" +
      "       ingest:import-queue resume [--queue <id>]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    // Every command outcome closes the pool (the worker closes it itself).
    .finally(() => closeDb());
