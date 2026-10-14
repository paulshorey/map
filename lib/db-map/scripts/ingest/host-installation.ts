import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

let identity: string | undefined;
export function hostInstallationId() {
  if (identity) return identity;
  const directory = join(homedir(), ".local/state/poi-map");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "host-id");
  try {
    writeFileSync(path, randomUUID() + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  identity = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f-]{36}$/.test(identity))
    throw new Error("Invalid ingestion host installation ID");
  return identity;
}
export function processStartIdentity(pid = process.pid): string | null {
  try {
    return (
      execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        timeout: 3000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}
