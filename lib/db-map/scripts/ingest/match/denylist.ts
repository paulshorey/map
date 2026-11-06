const DENIED_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "linktr.ee",
  "maps.google.com",
  "google.com",
  "goo.gl",
  "nps.gov",
  "recreation.gov",
  "reserveamerica.com",
  "koa.com",
  "wikidata.org",
  "wikipedia.org",
];

export function isDeniedDomain(domain: string | null | undefined): boolean {
  const value = (domain ?? "").toLowerCase().replace(/^www\./, "");
  if (!value) return true;
  return DENIED_DOMAINS.some((d) => value === d || value.endsWith(`.${d}`));
}

/**
 * Comparable identity of a website: host without `www.`, path without a trailing slash, and
 * the query without tracking parameters. Domains are shared by unrelated places (thousands
 * of Forest Service campgrounds live under `fs.usda.gov`), so a domain alone never identifies
 * a place. Denied hosts and unparsable values have no identity.
 */
export function websiteIdentity(url: string | null | undefined): string | null {
  const text = (url ?? "").trim();
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!hostname.includes(".") || isDeniedDomain(hostname)) return null;
  // A non-default port can serve an unrelated application.
  const host = parsed.port ? `${hostname}:${parsed.port}` : hostname;
  for (const key of [...parsed.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) parsed.searchParams.delete(key);
  parsed.searchParams.sort();
  // Paths are case-sensitive and kept as written (no decoding, which can throw on `%ZZ`).
  const path = parsed.pathname.replace(/\/+$/, "");
  const query = parsed.searchParams.toString();
  // Hash routes (`#/event/a`, `#!/event/a`) name distinct pages; in-page anchors do not.
  const route = /^#!?\//.test(parsed.hash) ? parsed.hash : "";
  return `${host}${path}${query ? `?${query}` : ""}${route}`;
}

export function strongContactSignal(
  aWebsite: string | null | undefined,
  bWebsite: string | null | undefined,
  aPhone: string | null | undefined,
  bPhone: string | null | undefined,
): { website: boolean; phone: boolean } {
  const a = websiteIdentity(aWebsite);
  const website = a !== null && a === websiteIdentity(bWebsite);

  const phoneA = (aPhone ?? "").replace(/[^\d+]/g, "");
  const phoneB = (bPhone ?? "").replace(/[^\d+]/g, "");
  const phone = phoneA.length >= 7 && phoneA === phoneB;

  return { website, phone };
}
