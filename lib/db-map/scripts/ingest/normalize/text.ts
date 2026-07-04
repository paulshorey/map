/** Text normalization helpers for the normalize stage (M5). */

const LEGAL_SUFFIXES = [
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "co",
  "corp",
  "corporation",
  "gmbh",
  "e.v.",
  "ev",
  "foundation",
  "trust",
];

export function stripDiacritics(s: string): string {
  // Decompose, remove ONLY Latin/general combining marks (U+0300–U+036F), then
  // recompose (NFC) so non-Latin scripts stay intact — e.g. Japanese dakuten
  // (ず = す + U+3099) must not be split into す, and CJK/Hangul are untouched.
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .normalize("NFC");
}

/**
 * Normalize a display name for matching: lowercase, strip diacritics, drop
 * punctuation and legal suffixes, collapse whitespace. Kept conservative so
 * trigram similarity still has enough signal.
 *
 * Unicode-aware: keeps letters/numbers of ANY script (CJK, Cyrillic, Arabic, …)
 * since the app is global from day one — only punctuation/symbols are stripped.
 */
export function normalizeName(name: string): string | null {
  let s = stripDiacritics(name).toLowerCase();
  s = s.replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (!s) return null;

  const tokens = s.split(" ").filter((t) => t.length > 0);
  while (tokens.length > 1 && LEGAL_SUFFIXES.includes(tokens[tokens.length - 1]!)) {
    tokens.pop();
  }
  const result = tokens.join(" ").trim();
  return result || null;
}

/**
 * Second-level public suffixes: when the last two labels are one of these, the
 * registrable domain includes a third label (e.g. example.co.uk, unam.gob.mx).
 * Best-effort list without a full Public Suffix List dependency; this only feeds
 * a weak, denylist-guarded match signal (M8), so approximate coverage is fine.
 */
const TWO_PART_TLDS = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "org.au",
  "net.au",
  "gov.au",
  "edu.au",
  "co.nz",
  "co.jp",
  "com.br",
  "com.mx",
  "gob.mx",
  "edu.mx",
  "org.mx",
  "co.za",
  "com.cn",
  "edu.cn",
  "gov.cn",
  "com.ar",
  "gov.in",
  "co.in",
  "ac.in",
]);

const IP_LIKE = /^\d{1,3}(\.\d{1,3}){3}$/;

export function websiteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    host = new URL(withScheme).hostname.toLowerCase();
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  // IP addresses are not registrable domains — not a useful match signal.
  if (IP_LIKE.test(host)) return null;

  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  // All-numeric hosts (partial IPs, ports leaking in) are not domains.
  if (labels.every((l) => /^\d+$/.test(l))) return null;

  const lastTwo = labels.slice(-2).join(".");
  if (TWO_PART_TLDS.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

/** Best-effort E.164 phone normalization. Returns null if too few digits. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const hasPlus = phone.trim().startsWith("+");
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return hasPlus ? `+${digits}` : digits;
}
