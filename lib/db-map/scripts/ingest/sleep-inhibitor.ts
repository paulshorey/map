import { spawn } from "node:child_process";

/** Keep a macOS worker awake while it holds session-level PostgreSQL locks. */
export async function holdSystemAwake(): Promise<() => void> {
  if (process.platform !== "darwin") return () => {};

  // -i covers idle sleep on battery; -s also prevents system sleep on AC.
  // -w binds the assertion to this worker PID, even if the worker is killed.
  const guard = spawn(
    "/usr/bin/caffeinate",
    ["-i", "-s", "-w", String(process.pid)],
    {
      // Worker-group SIGTERM/SIGINT must leave this assertion alive while the
      // current record checkpoints. -w still releases it if the worker dies.
      detached: true,
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolve, reject) => {
    guard.once("spawn", resolve);
    guard.once("error", reject);
  });

  const lost = (error?: Error | number | null) => {
    console.error(
      "Ingestion sleep prevention lost; exiting for recovery",
      error,
    );
    process.exit(1);
  };
  guard.on("error", lost);
  guard.on("exit", lost);
  if (guard.exitCode !== null || guard.signalCode !== null)
    lost(guard.exitCode);

  return () => {
    guard.off("error", lost);
    guard.off("exit", lost);
    guard.kill();
  };
}
