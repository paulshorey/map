import { mkdir, readFile, writeFile, rename, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { hostname } from "node:os";

export const JOBS = fileURLToPath(
  new URL("../../.ingest-jobs/", import.meta.url),
);
export const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export interface Job {
  id: string;
  mode: "runner" | "smoke";
  argv: string[];
  host: string;
  supervisor_pid?: number;
  child_pid?: number;
  run_id?: string;
  execution_id?: string;
  parent_thread?: string;
  runner_model: "gpt-5.6-luna";
  started_at: string;
  status: "queued" | "running" | "finished";
  timeout_seconds: number;
  health_interval_seconds: number;
  health_checks: number;
  last_health_at?: string;
  finished_at?: string;
  stop_reason?: string;
  result?: Record<string, unknown>;
}
export function jobPath(id: string, file = "job.json") {
  if (!UUID.test(id)) throw new Error("Expected a job UUID");
  return join(JOBS, id, file);
}
export async function atomicJson(path: string, value: unknown) {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
export async function loadJob(id: string): Promise<Job> {
  return JSON.parse(await readFile(jobPath(id), "utf8"));
}
export async function saveJob(job: Job) {
  await atomicJson(jobPath(job.id), job);
}
export async function createJob(job: Job) {
  await mkdir(JOBS, { recursive: true, mode: 0o700 });
  await mkdir(jobPath(job.id, ""), { mode: 0o700 });
  await saveJob(job);
}
export function pidPresent(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
export async function listJobs() {
  const entries = await readdir(JOBS).catch(() => [] as string[]);
  const jobs = [];
  for (const id of entries.filter((id) => UUID.test(id))) {
    const job = await loadJob(id);
    jobs.push({
      ...job,
      supervisor_present:
        job.host === hostname() ? pidPresent(job.supervisor_pid) : null,
      child_present: job.host === hostname() ? pidPresent(job.child_pid) : null,
    });
  }
  return jobs.sort((a, b) => b.started_at.localeCompare(a.started_at));
}
