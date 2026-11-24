import type { Extractor, RawRecord } from "../types.js";
import { parseGenericRecords, separateOccurrences } from "./generic.js";

// MusicBrainz event → place "held at" relationship.
const HELD_AT = "e2c6f697-07dc-38b1-be0b-83d740165532";

interface PlaceRelation {
  "target-type"?: string;
  "type-id"?: string;
  direction?: string;
  place?: {
    id?: string;
    name?: string;
    address?: string;
    area?: { type?: string; name?: string };
  };
}

export function withVenueAddress(record: RawRecord): RawRecord {
  if (
    record.address ||
    record.attributes?.venue_address ||
    record.attributes?.street_address ||
    (record.lat !== undefined && record.lng !== undefined)
  )
    return record;
  const { relations } = record.raw as { relations?: (PlaceRelation | null)[] };
  if (!Array.isArray(relations)) return record;
  const venues = relations.filter(
    (r) =>
      r?.["target-type"] === "place" &&
      r.direction === "forward" &&
      r["type-id"] === HELD_AT,
  );
  // A multi-site event has no single address, even if only one venue lists one.
  if (venues.length !== 1) return record;
  const place = venues[0]?.place;
  if (
    typeof place?.address !== "string" ||
    !place.address.trim() ||
    typeof place.id !== "string" ||
    !place.id.trim()
  )
    return record;
  const area = place.area;
  if (
    area?.type === "City" &&
    typeof area.name === "string" &&
    record.city &&
    area.name.trim().toLowerCase() !== record.city.toLowerCase()
  )
    return record;
  return {
    ...record,
    address: place.address.trim(),
    attributes: {
      ...record.attributes,
      musicbrainz_venue_mbid: place.id,
      ...(typeof place.name === "string" && place.name.trim()
        ? { musicbrainz_venue_name: place.name.trim() }
        : {}),
    },
  };
}

export const musicBrainzExtractor: Extractor = {
  slug: "musicbrainz",
  genericOccurrenceIdentity: true,
  async *parse(file) {
    const read = () => parseGenericRecords(file, { sourceSlug: "musicbrainz" });
    for await (const record of separateOccurrences(read, "musicbrainz")) {
      yield withVenueAddress(record);
    }
  },
};
