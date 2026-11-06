/**
 * Names for places whose source gives no real name (owner policy 2026-11-06).
 *
 * A nameless place is still published: the pipeline composes a descriptive display name from
 * the best data it has (kind of place, operator/brand/ref, street, locality, else coordinates)
 * and marks it generated. A generated name is never a proper name: it is not matched against
 * other names, a member with a real name wins canonical name selection, and the canonical POI
 * carries the `generated_name` review flag. The original source identity and tags stay as raw
 * evidence.
 */

/** Attribute keys owned by this policy; a source's own attributes can never set them. */
export const GENERATED_NAME_KEYS = [
  "name_generated",
  "generated_name",
  "generated_name_subject",
] as const;

const PLACEHOLDER_NAMES = new Set([
  "unnamed",
  "no name",
  "noname",
  "untitled",
  "unknown",
  "none",
  "null",
  "undefined",
  "n a",
  "na",
  "tbd",
]);

/** Blank, punctuation-only or a known placeholder such as "unnamed" or "N/A". */
export function isPlaceholderName(name: string | null | undefined): boolean {
  const trimmed = name?.trim();
  if (!trimmed) return true;
  const comparable = trimmed
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return !comparable || PLACEHOLDER_NAMES.has(comparable);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed || null;
}

/** OSM-style tags captured with the record (`attributes.osm_tags`, else `raw.all_tags`). */
export function sourceTags(
  attributes: Record<string, unknown>,
  raw: unknown,
): Record<string, unknown> {
  const tags = asRecord(attributes.osm_tags);
  if (Object.keys(tags).length) return tags;
  const allTags = asRecord(raw).all_tags;
  if (typeof allTags === "string") {
    try {
      return asRecord(JSON.parse(allTags));
    } catch {
      return {};
    }
  }
  return asRecord(allTags);
}

/** Language-specific (`name:de`) values are names; `name:signed` and similar flags are not. */
const NAME_LANGUAGE_KEY = /^name:[a-z]{2,3}(?:-[a-z]{2,4})?$/i;

/**
 * A real name the source gives outside its primary name field: an OSM `name:en`, another
 * language's name, `official_name`, `alt_name`, `loc_name`, `short_name` or `int_name`.
 */
export function realNameFromTags(tags: Record<string, unknown>): string | null {
  const ordered = [
    "name:en",
    "official_name",
    "int_name",
    ...Object.keys(tags)
      .filter((key) => NAME_LANGUAGE_KEY.test(key) && key !== "name:en")
      .sort(),
    "alt_name",
    "loc_name",
    "short_name",
  ];
  for (const key of ordered) {
    // Multi-valued OSM tags separate alternatives with ';'.
    const value = text(tags[key])?.split(";")[0]?.trim();
    if (value && !isPlaceholderName(value)) return value;
  }
  return null;
}

/** "campground" → "Campground", "art_fair" → "Art fair". */
export function categoryLabel(slug: string): string {
  const words = slug.replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Place";
}

const TAG_KIND_LABELS: Record<string, string> = {
  "tourism=caravan_site": "Caravan site",
  "tourism=camp_site": "Campsite",
  "tourism=camp_pitch": "Camp pitch",
  "tourism=picnic_site": "Picnic site",
  "tourism=viewpoint": "Viewpoint",
  "leisure=garden": "Garden",
  "leisure=park": "Park",
};

function kindLabel(
  tags: Record<string, unknown>,
  raw: Record<string, unknown>,
  ingestCategory: string,
): string {
  for (const key of ["tourism", "leisure", "amenity"]) {
    const value = text(tags[key]) ?? text(raw[key]);
    const label = value ? TAG_KIND_LABELS[`${key}=${value}`] : undefined;
    if (label) return label;
  }
  return categoryLabel(ingestCategory);
}

export interface GeneratedNameInput {
  ingestCategory: string;
  attributes: Record<string, unknown>;
  raw: unknown;
  address: string | null;
  city: string | null;
  region: string | null;
  countryCode: string | null;
  lat: number | null;
  lng: number | null;
}

export interface GeneratedName {
  /** Full display name, e.g. "Caravan site (Camping Co) on Rue X near Lyon, France". */
  name: string;
  /** The name without its locality, so a canonical can re-attach its resolved locality. */
  subject: string;
}

let regionNames: Intl.DisplayNames | null | undefined;
function countryName(code: string | null): string | null {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return code ?? null;
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(["en"], { type: "region" });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(code.toUpperCase()) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/**
 * "near Lyon, France" for a town; "in Alberta, Canada" or "in France" when only a region or
 * country is known. Null when nothing is known.
 */
export function localityLabel(input: {
  city: string | null;
  region: string | null;
  countryCode: string | null;
}): string | null {
  const city = text(input.city);
  const place = city ?? text(input.region);
  const country = countryName(text(input.countryCode));
  const parts = [place, country].filter((part): part is string => Boolean(part));
  if (!parts.length) return null;
  return `${city ? "near" : "in"} ${[...new Set(parts)].join(", ")}`;
}

function coordinatesLabel(lat: number | null, lng: number | null): string | null {
  if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng))
    return null;
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

/** Attach a locality phrase (or, failing that, coordinates) to a generated subject. */
export function composeGeneratedName(
  subject: string,
  locality: string | null,
  lat: number | null,
  lng: number | null,
): string {
  if (locality) return `${subject} ${locality}`;
  const coordinates = coordinatesLabel(lat, lng);
  return coordinates ? `${subject} at ${coordinates}` : subject;
}

/**
 * A descriptive name from the record's most specific data. Never a proper name: it states the
 * kind of place and qualifies it with what the source does say about it.
 */
export function generatePlaceName(input: GeneratedNameInput): GeneratedName {
  const tags = sourceTags(input.attributes, input.raw);
  const raw = asRecord(input.raw);
  const kind = kindLabel(tags, raw, input.ingestCategory);
  const owner =
    text(tags.brand) ??
    text(tags.operator) ??
    text(input.attributes.brand) ??
    text(input.attributes.operator);
  const ref = text(tags.ref);
  const qualifiers = [owner, ref ? `ref ${ref}` : null].filter(
    (part): part is string => Boolean(part),
  );
  const street =
    text(tags["addr:street"]) ??
    text(input.attributes.addr_street) ??
    text(tags["addr:place"]);
  const subject = [
    kind,
    qualifiers.length ? `(${qualifiers.join(", ")})` : null,
    street ? `on ${street}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  const locality = localityLabel({
    city: input.city ?? text(tags["addr:city"]),
    region: input.region ?? text(tags["addr:state"]),
    countryCode: input.countryCode ?? text(tags["addr:country"]),
  });
  return {
    name: composeGeneratedName(subject, locality, input.lat, input.lng),
    subject,
  };
}
