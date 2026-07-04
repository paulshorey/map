import { createHash } from "node:crypto";
import type { RawRecord } from "./types.js";

/** Fields that drive re-processing when changed (overview §5, M4.2). */
export function normalizablePayload(record: RawRecord): Record<string, unknown> {
  const attrs = record.attributes ? sortKeys(record.attributes) : null;
  return sortKeys({
    name: record.name ?? null,
    description: record.description ?? null,
    website: record.website ?? null,
    source_url: record.source_url ?? null,
    phone: record.phone ?? null,
    email: record.email ?? null,
    address: record.address ?? null,
    city: record.city ?? null,
    region: record.region ?? null,
    country_code: record.country_code ?? null,
    lat: record.lat ?? null,
    lng: record.lng ?? null,
    raw_category: record.raw_category ?? null,
    attributes: attrs,
  });
}

export function contentHash(record: RawRecord): string {
  const payload = JSON.stringify(normalizablePayload(record));
  return createHash("sha256").update(payload).digest("hex");
}

/** Deterministic id when a source has no natural record id (overview §14.2). */
export function synthSourceRecordId(
  sourceSlug: string,
  name: string,
  locality: string,
): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const key = `${sourceSlug}|${norm(name)}|${norm(locality)}`;
  return createHash("sha1").update(key).digest("hex");
}

function sortKeys<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) {
    out[k] = obj[k];
  }
  return out as T;
}
