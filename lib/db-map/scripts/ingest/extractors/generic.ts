/**
 * Generic extractor for files that follow the raw research capture spec
 * (poi-research/capture-spec.md).
 *
 * Sources registered in sources.ts without a custom extractor fall back to this
 * one, so a new spec-conformant source needs only a metadata entry — no code.
 *
 * Field mapping is intentionally forgiving about common aliases (lat/latitude,
 * lng/lon/longitude, url/source_url, country/country_code) but does no other
 * normalization: cleanup belongs to ingest:normalize.
 */
import type { Extractor } from "../types.js";
import { streamRecords } from "../io.js";
import { synthSourceRecordId } from "../hash.js";
import { str, num } from "./utils.js";

export interface GenericIdentityOptions {
  sourceSlug: string;
  field?: string;
  editioned?: boolean;
  /** URL keys counted across the file; only singleton URLs are safe identities. */
  uniqueUrls?: ReadonlySet<string>;
}

/** Fields mapped onto research_pois columns; everything else goes to attributes. */
const COLUMN_FIELDS = new Set([
  "source_record_id",
  "id",
  "name",
  "description",
  "website",
  "website_url",
  "source_url",
  "detail_url",
  "url",
  "phone",
  "email",
  "address",
  "city",
  "region",
  "state",
  "state_region",
  "country",
  "country_code",
  "lat",
  "latitude",
  "lng",
  "lon",
  "longitude",
  "raw_category",
  "category",
  "raw",
]);

function attributeValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  }
  return value;
}

function localityFor(
  r: Record<string, unknown>,
  lat: number | undefined,
  lng: number | undefined,
): string {
  const locality = [
    str(r.city),
    str(r.region) ?? str(r.state) ?? str(r.state_region),
    str(r.country_code) ?? str(r.country),
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  if (locality) return locality;
  if (lat !== undefined && lng !== undefined)
    return `${lat.toFixed(3)},${lng.toFixed(3)}`;
  return str(r.address) ?? str(r.street_address) ?? "";
}

function identityFor(
  r: Record<string, unknown>,
  sourceUrl: string | undefined,
  name: string | undefined,
  lat: number | undefined,
  lng: number | undefined,
  options: GenericIdentityOptions,
): Pick<
  import("../types.js").RawRecord,
  "source_record_id" | "source_record_id_kind" | "identity_inputs"
> {
  const configured = options.field ? str(r[options.field]) : undefined;
  const edition = options.editioned
    ? (str(r.start_date) ??
      str(r.starts_at) ??
      str(r.date)?.slice(0, 4) ??
      null)
    : null;
  const explicit = str(r.source_record_id);
  if (explicit)
    return { source_record_id: explicit, source_record_id_kind: "natural" };
  // A configured field may identify a series rather than an occurrence. Keep its
  // value readable while making an explicitly editioned source one-row-per-edition.
  if (configured) {
    return {
      source_record_id: edition ? `${configured}#${edition}` : configured,
      source_record_id_kind: "natural",
    };
  }
  const natural =
    str(r.id) ??
    str(r.slug) ??
    str(r.mbid) ??
    str(r.wikidata_qid) ??
    str(r.wikidata_id) ??
    str(r.artsy_id) ??
    str(r.ra_event_id);
  if (natural)
    return { source_record_id: natural, source_record_id_kind: "natural" };

  const url = str(r.detail_url) ?? sourceUrl;
  if (url && (!options.uniqueUrls || options.uniqueUrls.has(url))) {
    return { source_record_id: url, source_record_id_kind: "url" };
  }

  const locality = localityFor(r, lat, lng);
  if (!name || !locality)
    return { source_record_id: "", source_record_id_kind: "synthetic" };
  return {
    source_record_id: synthSourceRecordId(
      options.sourceSlug,
      name,
      locality,
      edition,
    ),
    source_record_id_kind: "synthetic",
    identity_inputs: { name, locality, edition },
  };
}

export function mapGenericRecord(
  raw: unknown,
  options: GenericIdentityOptions = { sourceSlug: "generic" },
): import("../types.js").RawRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  const sourceUrl = str(r.source_url) ?? str(r.detail_url) ?? str(r.url);
  const name = str(r.name) ?? str(r.title);
  const lat = num(r.lat ?? r.latitude);
  const lng = num(r.lng ?? r.lon ?? r.longitude);
  const identity = identityFor(r, sourceUrl, name, lat, lng, options);

  let countryCode = str(r.country_code);
  let countryName: string | undefined;
  const country = str(r.country);
  if (country) {
    if (!countryCode && /^[A-Za-z]{2}$/.test(country))
      countryCode = country.toUpperCase();
    else countryName = country;
  }

  const attributes: Record<string, unknown> = {};
  if (countryName) attributes.country_name = countryName;
  for (const [key, value] of Object.entries(r)) {
    if (COLUMN_FIELDS.has(key)) continue;
    const v = attributeValue(value);
    if (v !== undefined) attributes[key] = v;
  }
  const nested = r.attributes;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    delete attributes.attributes;
    for (const [key, value] of Object.entries(
      nested as Record<string, unknown>,
    )) {
      const v = attributeValue(value);
      if (v !== undefined) attributes[key] = v;
    }
  }

  return {
    ...identity,
    name,
    description: str(r.description) ?? str(r.excerpt),
    website: str(r.website) ?? str(r.website_url) ?? str(r.official_website),
    source_url: sourceUrl,
    phone: str(r.phone),
    email: str(r.email),
    address: str(r.address) ?? str(r.street_address),
    city: str(r.city),
    region: str(r.region) ?? str(r.state) ?? str(r.state_region),
    country_code: countryCode,
    lat,
    lng,
    raw_category: str(r.raw_category) ?? str(r.category),
    attributes,
    raw: r,
  };
}

export const genericExtractor: Extractor = {
  slug: "generic",
  async *parse(file) {
    yield* parseGenericRecords(file, { sourceSlug: "generic" });
  },
};

/** Two-pass generic parsing makes shared listing URLs ineligible as record keys. */
export async function* parseGenericRecords(
  file: string,
  options: Omit<GenericIdentityOptions, "uniqueUrls">,
): AsyncIterable<import("../types.js").RawRecord> {
  const counts = new Map<string, number>();
  for await (const raw of streamRecords(file)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (
      str(r.source_record_id) ??
      str(r[options.field ?? ""]) ??
      str(r.id) ??
      str(r.slug) ??
      str(r.mbid)
    )
      continue;
    const url = str(r.detail_url) ?? str(r.source_url) ?? str(r.url);
    if (url) counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  const uniqueUrls = new Set(
    [...counts].filter(([, count]) => count === 1).map(([url]) => url),
  );
  for await (const raw of streamRecords(file)) {
    const record = mapGenericRecord(raw, { ...options, uniqueUrls });
    if (record) yield record;
  }
}
