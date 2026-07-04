export interface StrongIds {
  wikidata: string[];
  osm: string[];
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function normalizeQid(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const hit = raw.match(/Q\d+/i);
  return hit ? hit[0].toUpperCase() : null;
}

function addUnique(list: string[], value: string | null): void {
  if (value && !list.includes(value)) list.push(value);
}

export function extractStrongIds(row: {
  source_record_id?: string | null;
  attributes?: unknown;
  raw?: unknown;
}): StrongIds {
  const attrs = asObject(row.attributes);
  const raw = asObject(row.raw);
  const wikidata: string[] = [];
  const osm: string[] = [];

  addUnique(wikidata, normalizeQid(row.source_record_id));
  addUnique(wikidata, normalizeQid(attrs.wikidata_id));
  addUnique(wikidata, normalizeQid(attrs.wikidata));
  addUnique(wikidata, normalizeQid(raw.wikidata_id));
  addUnique(wikidata, normalizeQid(raw.wikidata));

  const attrOsmId = stringValue(attrs.osm_id);
  const attrOsmType = stringValue(attrs.osm_type) ?? "node";
  if (attrOsmId) addUnique(osm, `${attrOsmType}/${attrOsmId}`);

  const rawOsmId = stringValue(raw.osm_id);
  const rawOsmType = stringValue(raw.osm_type) ?? "node";
  if (rawOsmId) addUnique(osm, `${rawOsmType}/${rawOsmId}`);

  const sourceId = stringValue(row.source_record_id);
  if (sourceId && /^(node|way|relation)\/\d+$/i.test(sourceId)) {
    addUnique(osm, sourceId.toLowerCase());
  }

  return { wikidata, osm };
}

