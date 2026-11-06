import { useCallback, useState } from "react";

/** Review flags the map can filter by; keys match @lib/db-map REVIEW_FLAGS. */
export const REVIEW_FLAG_LABELS: Record<string, { label: string; title: string }> = {
  general_location: {
    label: "General location",
    title: "Only a country, region or city is known",
  },
  source_needs_review: {
    label: "Source needs review",
    title: "From a capture whose category or import decision is not confirmed yet",
  },
};

const LS_KEY = "poi.review";

function readInitial(): string {
  try {
    const value = localStorage.getItem(LS_KEY);
    return value && value in REVIEW_FLAG_LABELS ? value : "all";
  } catch {
    return "all";
  }
}

/** `all`, or one review flag: only POIs carrying it. */
export function usePoiReviewFilter() {
  const [review, setReview] = useState<string>(() => readInitial());
  const selectReview = useCallback((next: string) => {
    setReview(next);
    try {
      if (next === "all") localStorage.removeItem(LS_KEY);
      else localStorage.setItem(LS_KEY, next);
    } catch {
      // Storage is a convenience; the filter still applies for this session.
    }
  }, []);
  return { review, selectReview };
}
