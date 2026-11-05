"use client";

import { HtmlDescription } from "@/components/HtmlDescription";
import { useEffect, useRef } from "react";
import type { PoiLocationRecord } from "@lib/db-map/contracts/map-app";
import type { PoiSelection } from "./usePoiSelection";

type Poi = PoiSelection["pois"][number];

interface Props {
  selection: PoiSelection;
  onClose: () => void;
}

const STATUS_STYLES: Record<string, string> = {
  upcoming: "bg-emerald-100 text-emerald-700",
  ongoing: "bg-amber-100 text-amber-700",
  past: "bg-gray-200 text-gray-600",
};

const STATUS_LABELS: Record<string, string> = {
  upcoming: "Upcoming",
  ongoing: "Happening now",
  past: "Ended",
};

/** Format a POI's event window respecting how precisely the date is known. */
function formatEventDates(
  startsAt?: string | null,
  endsAt?: string | null,
  precision?: string | null,
): string | null {
  if (!startsAt) return null;
  const start = new Date(startsAt);
  if (isNaN(start.getTime())) return null;

  const opts: Intl.DateTimeFormatOptions =
    precision === "year"
      ? { year: "numeric", timeZone: "UTC" }
      : precision === "month"
        ? { year: "numeric", month: "long", timeZone: "UTC" }
        : precision === "datetime"
          ? {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
              timeZone: "UTC",
            }
          : {
              year: "numeric",
              month: "short",
              day: "numeric",
              timeZone: "UTC",
            };

  const fmt = (d: Date) => new Intl.DateTimeFormat("en-US", opts).format(d);
  const startStr = fmt(start);

  if (!endsAt) return startStr;
  const end = new Date(endsAt);
  if (isNaN(end.getTime()) || fmt(end) === startStr) return startStr;
  return `${startStr} – ${fmt(end)}`;
}

export function PoiDrawer({ selection, onClose }: Props) {
  const drawerRef = useRef<HTMLDivElement>(null);
  const { pois, total, truncated, location } = selection;
  const stacked = pois.length > 1;
  const first = pois[0];

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function handleClick(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  if (!first) return null;

  return (
    <div
      ref={drawerRef}
      className="absolute top-0 right-0 z-20 h-full w-96 max-w-full bg-white shadow-2xl border-l border-gray-200 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 gap-2">
        <div className="min-w-0">
          {stacked ? (
            <>
              <h2 className="text-lg font-semibold text-gray-900 leading-tight">
                {total} places at this location
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                {truncated ? `Showing ${pois.length}. ` : ""}
                The clicked place is first.
                {location && (
                  <span className="font-mono">
                    {" "}
                    {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
                    {location.precision !== "point"
                      ? ` · ${location.precision}`
                      : ""}
                  </span>
                )}
              </p>
            </>
          ) : (
            <PoiHeading poi={first} />
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 cursor-pointer shrink-0 mt-0.5"
          aria-label="Close"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      {/* Body: one card per POI at this point */}
      <div className="flex-1 overflow-y-auto">
        {stacked ? (
          <ol className="divide-y divide-gray-200">
            {pois.map((poi, i) => (
              <li key={poi.id} className={i === 0 ? "bg-blue-50/40" : ""}>
                <div className="px-5 pt-4">
                  <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-1">
                    {i + 1} of {total}
                    {i === 0 ? " · clicked" : ""}
                  </p>
                  <PoiHeading poi={poi} />
                </div>
                <PoiBody poi={poi} />
              </li>
            ))}
          </ol>
        ) : (
          <PoiBody poi={first} />
        )}
      </div>
    </div>
  );
}

function isGeneral(poi: Poi): boolean {
  return (
    (poi.attributes as { location_specificity?: string } | null)
      ?.location_specificity === "general"
  );
}

function PoiHeading({ poi }: { poi: Poi }) {
  const status = poi.status ?? undefined;
  return (
    <>
      <h2 className="text-lg font-semibold text-gray-900 leading-tight">
        {poi.name}
      </h2>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span className="inline-block rounded-full bg-blue-100 text-blue-700 px-2.5 py-0.5 text-xs font-medium">
          {poi.category}
        </span>
        {status && (
          <span
            className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[status] ?? "bg-gray-100 text-gray-600"}`}
          >
            {STATUS_LABELS[status] ?? status}
          </span>
        )}
        {isGeneral(poi) && (
          <span className="inline-block rounded-full bg-amber-100 text-amber-800 px-2.5 py-0.5 text-xs font-medium">
            General location
          </span>
        )}
      </div>
    </>
  );
}

function PoiBody({ poi }: { poi: Poi }) {
  const eventDates = formatEventDates(
    poi.starts_at,
    poi.ends_at,
    poi.date_precision,
  );
  const namedLocations = Object.values(poi.coordinate_evidence ?? {}).filter(
    (p): p is PoiLocationRecord => !!p,
  );
  const locations = namedLocations.length
    ? namedLocations
    : (poi.locations ?? []);

  return (
    <div>
      {poi.photo_url && (
        <img
          src={poi.photo_url}
          alt={poi.name}
          className="w-full h-48 object-cover"
        />
      )}

      <div className="p-5 space-y-4">
        {/* Description */}
        {poi.description && <HtmlDescription html={poi.description} />}

        {/* Detail rows */}
        <div className="space-y-3">
          {eventDates && (
            <DetailRow icon={<CalendarIcon />} label="Dates">
              {eventDates}
            </DetailRow>
          )}

          {poi.address && (
            <DetailRow icon={<MapPinIcon />} label="Address">
              {poi.address}
            </DetailRow>
          )}

          {poi.hours && (
            <DetailRow icon={<ClockIcon />} label="Hours">
              {poi.hours}
            </DetailRow>
          )}

          {poi.website && (
            <DetailRow icon={<GlobeIcon />} label="Website">
              <a
                href={poi.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:underline break-all"
              >
                {poi.website.replace(/^https?:\/\/(www\.)?/, "")}
              </a>
            </DetailRow>
          )}

          {poi.sources?.length ? (
            <DetailRow icon={<ListIcon />} label="Sources">
              {poi.sources.join(", ")}
            </DetailRow>
          ) : null}

          {locations.length ? (
            <DetailRow icon={<CoordIcon />} label="Map locations">
              <div className="space-y-2">
                {(poi.attributes as { location_specificity?: string } | null)
                  ?.location_specificity === "general" && (
                  <p className="text-xs font-medium text-amber-700">
                    General location: only a country, region or city is known
                  </p>
                )}
                {locations.map((location) => (
                  <div key={`${location.kind}:${location.lat},${location.lng}`}>
                    <p className="text-xs">
                      {location.origin === "listed_address_geocode"
                        ? "Inferred from listing text"
                        : location.origin === "source_coordinates"
                          ? "Source coordinates"
                          : location.origin === "geocode"
                            ? "Geocoded coordinates"
                            : location.origin === "legacy_coordinates"
                              ? "Legacy coordinates"
                              : `Origin: ${location.origin || "unknown"}`}
                      {location.precision !== "point"
                        ? ` · Approximate ${location.precision}`
                        : ""}
                    </p>
                    <span className="font-mono text-xs">
                      {location.lat.toFixed(4)}, {location.lng.toFixed(4)}
                    </span>
                    {(location.query || location.label) && (
                      <p className="text-xs text-gray-500">
                        {location.query || location.label}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </DetailRow>
          ) : (
            poi.lat != null &&
            poi.lng != null && (
              <DetailRow icon={<CoordIcon />} label="Coordinates">
                <span className="font-mono text-xs">
                  {poi.lat.toFixed(4)}, {poi.lng.toFixed(4)}
                </span>
              </DetailRow>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="text-gray-400 mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">
          {label}
        </p>
        <div className="text-sm text-gray-700">{children}</div>
      </div>
    </div>
  );
}

function CalendarIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 2v4" />
      <path d="M16 2v4" />
      <rect width="18" height="18" x="3" y="4" rx="2" />
      <path d="M3 10h18" />
    </svg>
  );
}

function MapPinIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 6h13" />
      <path d="M8 12h13" />
      <path d="M8 18h13" />
      <path d="M3 6h.01" />
      <path d="M3 12h.01" />
      <path d="M3 18h.01" />
    </svg>
  );
}

function CoordIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v4" />
      <path d="M12 18v4" />
      <path d="M2 12h4" />
      <path d="M18 12h4" />
    </svg>
  );
}
