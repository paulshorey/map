import {
  readCoordinateEvidence,
  validPoint,
  type CoordinateEvidence,
  type MapLocation,
} from "../../lib/ingestion/location-points.js";
import {
  LOCATION_VERSION,
  forwardLocalityConflict,
  localityValue,
} from "./location.js";

export interface LocationMember {
  id: string;
  source_id: string;
  source_slug: string;
  source_trust: number;
  lat: number | null;
  lng: number | null;
  coordinate_precision: string | null;
  coordinate_source?: string | null;
  active_normalization_id: string | null;
  active_geocode_id: string | null;
  location_validation: Record<string, unknown> | null;
}
export interface CanonicalMapLocation extends MapLocation {
  research_id: string;
  source_id: string;
  source: string;
  normalization_id: string | null;
  geocode_id: string | null;
}

function sourceFallback(row: LocationMember): MapLocation | null {
  if (
    !validPoint(row) ||
    !["source", "url"].includes(row.coordinate_source ?? "")
  )
    return null;
  return {
    lat: row.lat!,
    lng: row.lng!,
    kind: "source",
    origin: "source_coordinates",
    precision: row.coordinate_precision ?? "point",
    label: null,
    query: null,
  };
}

function memberEvidence(row: LocationMember): CoordinateEvidence {
  const v = row.location_validation;
  if (
    !v ||
    v.version !== LOCATION_VERSION ||
    v.normalization_id !== row.active_normalization_id ||
    !row.active_geocode_id ||
    !validPoint(v.point) ||
    v.point.lat !== row.lat ||
    v.point.lng !== row.lng
  )
    return {
      source_coordinates: sourceFallback(row),
      inferred_coordinates: null,
    };
  return readCoordinateEvidence(v.coordinate_evidence);
}

const PRECISION_RANK: Record<string, number> = {
  point: 3,
  city: 2,
  region: 1,
  country: 0,
};

/** Listed-text evidence strength: a lookup that contradicts its listed city ranks last,
 * then a supplied street address beats venue/name text, then finer provider precision. */
function inferredRank(
  row: LocationMember,
  p: MapLocation,
  sourcePoint: MapLocation | null,
): number[] {
  const v = row.location_validation as {
    listed?: {
      address?: unknown;
      city?: unknown;
      hints?: { city?: unknown; location?: unknown } | null;
    };
    forward?: {
      result?: Parameters<typeof forwardLocalityConflict>[1];
      rejected?: unknown;
      city_confirmation?: { result?: { lat: number; lng: number } };
    };
  } | null;
  // Same listed city as the lookup (`listedLocality`): captured text, then the city hint.
  const listedCity =
    localityValue(v?.listed?.city) ?? localityValue(v?.listed?.hints?.city);
  // Only a captured street address earns address priority. `hints.location` is a listing
  // label such as "Melbourne, VIC" or "Australia", never a street address.
  const listedAddress = localityValue(v?.listed?.address);
  const result = v?.forward?.result;
  const confirmation = v?.forward?.city_confirmation?.result;
  // After a rejected venue/address hit, the stored result is the listed city's own lookup;
  // the venue-conflict test does not apply to it (Nagoya → 名古屋市 is the accepted answer).
  const cityFallback = !!v?.forward?.rejected;
  const conflict =
    !cityFallback &&
    !!result &&
    validPoint(result) &&
    result.lat === p.lat &&
    result.lng === p.lng &&
    forwardLocalityConflict(
      listedCity,
      result,
      validPoint(confirmation) ? confirmation : sourcePoint,
    );
  return [
    conflict ? 0 : 1,
    listedAddress && !v?.forward?.rejected ? 1 : 0,
    PRECISION_RANK[p.precision] ?? PRECISION_RANK.point!,
  ];
}

const compareRank = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!;
  return 0;
};

/** Choose one value independently for each provenance slot; source points cannot occupy the inferred slot. */
export function canonicalCoordinateEvidence(
  rows: LocationMember[],
  anchor: LocationMember | null,
): CoordinateEvidence<CanonicalMapLocation> {
  const ordered = [
    ...(anchor ? [anchor] : []),
    ...rows
      .filter((r) => r.id !== anchor?.id)
      .sort(
        (a, b) => b.source_trust - a.source_trust || a.id.localeCompare(b.id),
      ),
  ];
  const located = ordered.map((row) => ({
    row,
    evidence: memberEvidence(row),
  }));
  const pick = (
    slot: keyof CoordinateEvidence,
    candidates: typeof located,
  ): CanonicalMapLocation | null => {
    const hit = candidates.find((c) => c.evidence[slot]);
    if (!hit) return null;
    const { row } = hit;
    return {
      ...hit.evidence[slot]!,
      research_id: row.id,
      source_id: row.source_id,
      source: row.source_slug,
      normalization_id: row.active_normalization_id,
      geocode_id: row.active_geocode_id,
    };
  };
  // Source points keep anchor/trust order. Inferred candidates rank by evidence first, so a
  // weaker venue-name lookup from the anchor cannot displace another member's address lookup.
  const inferred = located
    .filter((c) => c.evidence.inferred_coordinates)
    .map((c, order) => ({
      ...c,
      order,
      rank: inferredRank(
        c.row,
        c.evidence.inferred_coordinates!,
        c.evidence.source_coordinates,
      ),
    }))
    .sort((a, b) => compareRank(a.rank, b.rank) || a.order - b.order);
  return {
    source_coordinates: pick("source_coordinates", located),
    inferred_coordinates: pick("inferred_coordinates", inferred),
  };
}

export type LocationSpecificity = "general" | "precise";

/** `general` when the published location rests only on country/region/city: no point-precision
 * source coordinates and no point-precision lookup of an address, venue or name. Null when the
 * canonical has no slotted evidence (legacy builds), which callers treat as not general. */
export function locationSpecificity(
  evidence: CoordinateEvidence<CanonicalMapLocation>,
  rows: LocationMember[],
): LocationSpecificity | null {
  const source = evidence.source_coordinates,
    inferred = evidence.inferred_coordinates;
  if (!source && !inferred) return null;
  if (source?.precision === "point") return "precise";
  if (inferred?.precision === "point") {
    const forward = (
      rows.find((r) => r.id === inferred.research_id)?.location_validation as {
        forward?: { query_basis?: unknown; rejected?: unknown };
      } | null
    )?.forward;
    // A rejected venue/address hit leaves the listed city's own lookup.
    if (forward?.query_basis !== "locality" && !forward?.rejected)
      return "precise";
  }
  return "general";
}

/** Legacy output remains one stored point when its listed-text evidence is unavailable. */
export function canonicalPoints(
  rows: LocationMember[],
  anchor: LocationMember | null,
): CanonicalMapLocation[] {
  const e = canonicalCoordinateEvidence(rows, anchor);
  const points = [e.source_coordinates, e.inferred_coordinates].filter(
    (p): p is CanonicalMapLocation => !!p,
  );
  if (points.length || !anchor || !validPoint(anchor)) return points;
  return [
    {
      lat: anchor.lat!,
      lng: anchor.lng!,
      kind: "legacy",
      origin:
        anchor.coordinate_source === "geocode"
          ? "geocode"
          : "legacy_coordinates",
      precision: anchor.coordinate_precision ?? "point",
      label: null,
      query: null,
      research_id: anchor.id,
      source_id: anchor.source_id,
      source: anchor.source_slug,
      normalization_id: anchor.active_normalization_id,
      geocode_id: anchor.active_geocode_id,
    },
  ];
}
