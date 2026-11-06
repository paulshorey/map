"use client";

import type { PoiLocationFilter } from "./usePoiLocationFilter";
import { REVIEW_FLAG_LABELS } from "./usePoiReviewFilter";

const LOCATION_OPTIONS: Array<{
  value: PoiLocationFilter;
  label: string;
  short: string;
  title: string;
}> = [
  {
    value: "general",
    label: "Only general",
    short: "General",
    title: "Only POIs located just by country, region or city",
  },
  { value: "all", label: "All", short: "All", title: "All POIs" },
  {
    value: "precise",
    label: "Only precise",
    short: "Precise",
    title: "Only POIs with coordinates, an address or a found venue",
  },
];

export function LocationFilter({
  value,
  onChange,
}: {
  value: PoiLocationFilter;
  onChange: (next: PoiLocationFilter) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Location precision"
      className="flex rounded-lg bg-white p-0.5 shadow-lg border border-gray-200 text-sm"
    >
      {LOCATION_OPTIONS.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="radio"
            aria-checked={active}
            title={option.title}
            onClick={() => onChange(option.value)}
            className={`rounded-md px-2.5 py-1.5 font-medium transition-colors cursor-pointer whitespace-nowrap ${
              active
                ? "bg-blue-50 text-blue-700"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            <span className="sm:hidden">{option.short}</span>
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Always visible: every matching POI in view, even beyond the marker limit. */
export function ResultCount({
  total,
  returned,
  isFetching,
  isError,
}: {
  total: number | undefined;
  returned: number | undefined;
  isFetching: boolean;
  isError: boolean;
}) {
  const text = isError
    ? "Couldn't load results"
    : total === undefined
      ? "Loading results…"
      : `${fmt(total)} ${total === 1 ? "result" : "results"}${
          returned !== undefined && returned < total
            ? ` · showing ${fmt(returned)}`
            : ""
        }`;
  return (
    <div
      role="status"
      aria-live="polite"
      className={`rounded-lg bg-white/95 px-2.5 py-1 text-xs font-medium shadow border border-gray-200 tabular-nums transition-opacity ${
        isError ? "text-red-600" : "text-gray-700"
      } ${isFetching && total !== undefined ? "opacity-60" : ""}`}
    >
      {text}
    </div>
  );
}

/** Troubleshooting filter: only POIs carrying one review flag. */
export function ReviewFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex items-center rounded-lg bg-white px-2 py-1 shadow-lg border border-gray-200 text-sm">
      <span className="sr-only">Review flag</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        title="Show only POIs flagged for review"
        className={`bg-transparent font-medium cursor-pointer outline-none ${
          value === "all" ? "text-gray-600" : "text-amber-700"
        }`}
      >
        <option value="all">All POIs</option>
        {Object.entries(REVIEW_FLAG_LABELS).map(([flag, { label, title }]) => (
          <option key={flag} value={flag} title={title}>
            Review: {label}
          </option>
        ))}
      </select>
    </label>
  );
}
