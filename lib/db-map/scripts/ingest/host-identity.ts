import { hostname } from "node:os";

/** Only the single-label mDNS suffix is a safe alias for a short host name. */
function canonicalHost(host: string) {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (
    !name ||
    name.startsWith(".") ||
    name.endsWith(".") ||
    name.includes("..")
  )
    return null;
  return /^[^.]+\.local$/.test(name) ? name.slice(0, -".local".length) : name;
}

export function isLocalHost(recordedHost: string, currentHost = hostname()) {
  const recorded = canonicalHost(recordedHost);
  return recorded !== null && recorded === canonicalHost(currentHost);
}
