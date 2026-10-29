import { useState, useCallback } from "react";

/** `general`: only POIs whose location is just a country/region/city; `precise`: the rest. */
export type PoiLocationFilter = "all" | "general" | "precise";

const LS_KEY = "poi.location";

function readInitial(): PoiLocationFilter {
  try {
    const ls = localStorage.getItem(LS_KEY);
    return ls === "general" || ls === "precise" ? ls : "all";
  } catch {
    return "all";
  }
}

export function usePoiLocationFilter() {
  const [location, setLocation] = useState<PoiLocationFilter>(() =>
    readInitial(),
  );

  const selectLocation = useCallback((next: PoiLocationFilter) => {
    setLocation(next);
    try {
      if (next === "all") localStorage.removeItem(LS_KEY);
      else localStorage.setItem(LS_KEY, next);
    } catch {
      // Storage is a convenience; the filter still applies for this session.
    }
  }, []);

  return { location, selectLocation };
}
