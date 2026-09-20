import { spawn as nodeSpawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

type Spawn = typeof nodeSpawn;
let spawnProcess: Spawn = nodeSpawn;
let commandTimeoutMs = 30_000;

export type Probe = { status: "ready" | "unavailable"; reason?: string };
export type Notification = {
  status: "sent" | "deferred" | "uncertain";
  reason?: string;
};

export function __setSpawnForTests(spawn: Spawn) {
  spawnProcess = spawn;
}

export function __setRequestTimeoutForTests(ms: number) {
  commandTimeoutMs = ms;
}

export function managedCodexPath() {
  const override = process.env.CODEX_INGEST_CLI;
  if (override) {
    if (!isAbsolute(override))
      throw new Error("CODEX_INGEST_CLI must be an absolute path");
    return override;
  }
  return join(
    homedir(),
    ".codex",
    "packages",
    "standalone",
    "current",
    "codex",
  );
}

type CommandResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
};

function runCodex(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawnProcess(managedCodexPath(), args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (result: Omit<CommandResult, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + String(chunk)).slice(-4096);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });
    child.once("error", (error) =>
      finish({
        code: null,
        signal: null,
        error: error.message,
        timedOut,
      }),
    );
    child.once("exit", (code, signal) => finish({ code, signal, timedOut }));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      finish({ code: null, signal: null, timedOut });
    }, commandTimeoutMs);
  });
}

function explanation(result: CommandResult) {
  return (
    result.error ||
    result.stderr.trim() ||
    result.stdout.trim() ||
    `Codex command exited ${result.code ?? result.signal ?? "without status"}`
  ).slice(0, 2000);
}

/** Verify the standalone installation and daemon without invoking a model. */
export async function probeParent(_threadId: string): Promise<Probe> {
  let executable: string;
  try {
    executable = managedCodexPath();
    await access(executable, constants.X_OK);
  } catch (error) {
    return {
      status: "unavailable",
      reason: `Managed Codex installation unavailable: ${(error as Error).message}`,
    };
  }
  const started = await runCodex(["app-server", "daemon", "start"]);
  if (started.code !== 0)
    return { status: "unavailable", reason: explanation(started) };
  const version = await runCodex(["app-server", "daemon", "version"]);
  if (version.code !== 0)
    return { status: "unavailable", reason: explanation(version) };
  try {
    const state = JSON.parse(version.stdout) as {
      status?: string;
      cliVersion?: string;
      appServerVersion?: string;
    };
    if (state.status !== "running")
      return {
        status: "unavailable",
        reason: `Managed daemon status is ${String(state.status ?? "unknown")}`,
      };
    if (
      state.cliVersion &&
      state.appServerVersion &&
      state.cliVersion !== state.appServerVersion
    )
      return {
        status: "unavailable",
        reason: `Codex CLI/server version mismatch (${state.cliVersion}/${state.appServerVersion})`,
      };
    return { status: "ready" };
  } catch {
    return {
      status: "unavailable",
      reason: "Managed daemon returned invalid version status",
    };
  }
}

/** Queue one terminal message on the parent's shared local Codex daemon. */
export async function notifyParent(
  threadId: string,
  eventId: string,
  message: string,
): Promise<Notification> {
  const result = await runCodex([
    "queue",
    "--remote",
    "unix://",
    "--thread",
    threadId,
    "--message",
    `[${eventId}] ${message}`,
  ]);
  if (result.code === 0) return { status: "sent" };
  if (result.timedOut || result.error || result.signal)
    return { status: "uncertain", reason: explanation(result) };
  return { status: "deferred", reason: explanation(result) };
}
