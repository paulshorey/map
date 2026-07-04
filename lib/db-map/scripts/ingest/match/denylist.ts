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

export function strongContactSignal(
  aDomain: string | null | undefined,
  bDomain: string | null | undefined,
  aPhone: string | null | undefined,
  bPhone: string | null | undefined,
): { website: boolean; phone: boolean } {
  const domainA = (aDomain ?? "").toLowerCase().replace(/^www\./, "");
  const domainB = (bDomain ?? "").toLowerCase().replace(/^www\./, "");
  const website =
    domainA.length > 0 &&
    domainA === domainB &&
    !isDeniedDomain(domainA);

  const phoneA = (aPhone ?? "").replace(/[^\d+]/g, "");
  const phoneB = (bPhone ?? "").replace(/[^\d+]/g, "");
  const phone = phoneA.length >= 7 && phoneA === phoneB;

  return { website, phone };
}

