import { spawn } from "node:child_process";
import { open } from "node:fs/promises";

export interface ProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  log: string;
  timeoutMs: number;
  graceMs: number;
  healthIntervalMs: number;
  health: () => Promise<string | undefined>;
  onStart: (pid: number) => Promise<void>;
  onMessage: (message: unknown) => Promise<void>;
  registerStop: (stop: (reason: string) => void) => () => void;
}

/** Owns only the group created by this live ChildProcess, never a persisted PID. */
export async function superviseProcess(opts: ProcessOptions) {
  const log = await open(opts.log, "a", 0o600);
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    detached: true,
    stdio: ["ignore", log.fd, log.fd, "ipc"],
  });
  let reason: string | undefined,
    forced = false,
    exited = false,
    healthChecks = 0;
  let forceTimer: NodeJS.Timeout | undefined,
    healthTimer: NodeJS.Timeout | undefined;
  let forceFinished = () => {};
  let forceWork: Promise<void> | undefined;
  let messageWork = Promise.resolve(),
    healthWork = Promise.resolve();
  const groupPresent = () => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };
  const signal = (value: NodeJS.Signals) => {
    if (!child.pid) return false;
    try {
      process.kill(-child.pid, value);
      return true;
    } catch {
      return false;
    }
  };
  const stop = (why: string) => {
    if (reason || (exited && !groupPresent())) return;
    reason = why;
    signal("SIGTERM");
    forceWork = new Promise<void>((resolve) => {
      forceFinished = resolve;
    });
    forceTimer = setTimeout(() => {
      if (groupPresent()) forced = signal("SIGKILL");
      forceFinished();
    }, opts.graceMs);
  };
  const terminal = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: string;
  }>((resolve) => {
    child.once("error", (error) => {
      exited = true;
      resolve({ code: null, signal: null, error: error.message });
    });
    child.once("exit", (code, exitSignal) => {
      exited = true;
      resolve({ code, signal: exitSignal });
    });
  });
  child.on("message", (message) => {
    messageWork = messageWork
      .then(() => opts.onMessage(message))
      .catch((error) => stop(`identity_capture_failed: ${error.message}`));
  });
  let unregister = () => {};
  try {
    unregister = opts.registerStop(stop);
  } catch (error) {
    stop(`stop_registration_failed: ${(error as Error).message}`);
  }
  const deadline = setTimeout(() => stop("wall_clock_limit"), opts.timeoutMs);
  const tick = async () => {
    if (exited) return;
    try {
      healthChecks++;
      const problem = await opts.health();
      if (problem) stop(problem);
    } catch {
      stop("health_probe_failed");
    }
    if (!exited)
      healthTimer = setTimeout(() => {
        healthWork = tick();
      }, opts.healthIntervalMs);
  };
  healthTimer = setTimeout(() => {
    healthWork = tick();
  }, opts.healthIntervalMs);
  try {
    if (child.pid)
      await opts
        .onStart(child.pid)
        .catch((error) => stop(`startup_tracking_failed: ${error.message}`));
    const result = await terminal;
    clearTimeout(deadline);
    clearTimeout(healthTimer);
    await messageWork;
    await healthWork;
    if (groupPresent()) {
      // The leader can exit on TERM while its descendant ignores it. Finish the owned group.
      stop("orphan_descendants_after_exit");
      await forceWork;
    } else {
      clearTimeout(forceTimer);
      forceFinished();
    }
    return { ...result, stopReason: reason, forced, healthChecks };
  } finally {
    clearTimeout(deadline);
    clearTimeout(healthTimer);
    clearTimeout(forceTimer);
    unregister();
    await log.close();
  }
}
