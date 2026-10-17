/** Coordinate evidence, not a claim that two points are two verified venues. */
export interface MapLocation {
  lat: number;
  lng: number;
  origin: string;
  role: string;
  precision: string;
  label: string | null;
  query: string | null;
}

export function validPoint(
  value: unknown,
): value is { lat: number; lng: number } {
  if (!value || typeof value !== "object") return false;
  const p = value as { lat?: unknown; lng?: unknown };
  return (
    typeof p.lat === "number" &&
    typeof p.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lng) <= 180 &&
    !(p.lat === 0 && p.lng === 0)
  );
}

/** Collapse exact duplicates only. Nearby/conflicting candidates are deliberately retained. */
export function twoPoints<T extends { lat: number; lng: number }>(
  points: T[],
): T[] {
  const result: T[] = [];
  for (const p of points) {
    if (
      !validPoint(p) ||
      result.some((r) => r.lat === p.lat && r.lng === p.lng)
    )
      continue;
    result.push(p);
    if (result.length === 2) break;
  }
  return result;
}

/** Only explicit captured coordinates qualify; never consume model-proposed locations. */
export function capturedPoints(value: unknown): MapLocation[] {
  if (!Array.isArray(value)) return [];
  return twoPoints(
    value.filter(validPoint).map((p) => {
      const row = p as Record<string, unknown>;
      return {
        lat: p.lat,
        lng: p.lng,
        origin: "source_coordinates",
        role: typeof row.role === "string" ? row.role : "alternate",
        precision: ["point", "city", "region"].includes(String(row.precision))
          ? String(row.precision)
          : "point",
        label: typeof row.label === "string" ? row.label : null,
        query: null,
      };
    }),
  );
}
