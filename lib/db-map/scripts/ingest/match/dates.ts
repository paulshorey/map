export interface DateBearing {
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  date_precision?: string | null;
}

export interface DateCompatibilityInput {
  current: DateBearing;
  candidate: DateBearing;
  nameSimilarity: number;
  semanticSimilarity: number;
  localitySimilarity: number;
  distanceM: number;
}

export interface DateCompatibilitySignal {
  compatible: boolean | null;
  conflict: boolean;
  reason: string;
  days_apart: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value: Date | string | null): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateRange(row: DateBearing): { start: Date; end: Date } | null {
  const start = toDate(row.starts_at);
  if (!start) return null;
  const parsedEnd = toDate(row.ends_at);
  const end = parsedEnd && parsedEnd >= start ? parsedEnd : start;
  return { start, end };
}

function overlaps(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): boolean {
  return a.start <= b.end && b.start <= a.end;
}

function daysBetween(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): number {
  if (overlaps(a, b)) return 0;
  const left = a.end < b.start ? b.start.getTime() - a.end.getTime() : a.start.getTime() - b.end.getTime();
  return Math.max(1, Math.round(left / DAY_MS));
}

function recurringEventLikely(input: DateCompatibilityInput): boolean {
  return (
    input.nameSimilarity >= 0.82 &&
    input.semanticSimilarity >= 0.78 &&
    (input.localitySimilarity >= 0.66 || input.distanceM <= 1_000)
  );
}

/**
 * Dates are a guardrail for events: overlapping dates support a match, conflicting
 * dates can veto auto-merge, and same-name same-venue annual editions remain mergeable.
 */
export function dateCompatibility(input: DateCompatibilityInput): DateCompatibilitySignal {
  const current = dateRange(input.current);
  const candidate = dateRange(input.candidate);
  if (!current || !candidate) {
    return {
      compatible: null,
      conflict: false,
      reason: "missing_date",
      days_apart: null,
    };
  }

  const apart = daysBetween(current, candidate);
  if (apart === 0) {
    return {
      compatible: true,
      conflict: false,
      reason: "date_ranges_overlap",
      days_apart: 0,
    };
  }

  if (recurringEventLikely(input)) {
    return {
      compatible: true,
      conflict: false,
      reason: "same_event_different_edition",
      days_apart: apart,
    };
  }

  if (input.nameSimilarity < 0.72 || input.semanticSimilarity < 0.72) {
    return {
      compatible: false,
      conflict: true,
      reason: "different_dates_low_similarity",
      days_apart: apart,
    };
  }

  return {
    compatible: null,
    conflict: false,
    reason: "different_dates_gray_zone",
    days_apart: apart,
  };
}
