'use client';

import { useEffect, useRef } from 'react';

interface Props {
  poi: {
    name: string;
    category: string;
    description?: string;
    address?: string;
    website?: string;
    hours?: string;
    photo_url?: string;
    lat?: number;
    lng?: number;
  };
  onClose: () => void;
}

export function PoiDrawer({ poi, onClose }: Props) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function handleClick(e: MouseEvent) {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener('keydown', handleKey);
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('keydown', handleKey);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [onClose]);

  return (
    <div
      ref={drawerRef}
      className="absolute top-0 right-0 z-20 h-full w-96 max-w-full bg-white shadow-2xl border-l border-gray-200 flex flex-col"
    >
      {/* Header */}
      <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100 gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-gray-900 leading-tight">
            {poi.name}
          </h2>
          <span className="inline-block mt-1.5 rounded-full bg-blue-100 text-blue-700 px-2.5 py-0.5 text-xs font-medium">
            {poi.category}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 rounded-lg hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600 cursor-pointer shrink-0 mt-0.5"
          aria-label="Close"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18" /><path d="m6 6 12 12" />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {poi.photo_url && (
          <img src={poi.photo_url} alt={poi.name} className="w-full h-48 object-cover" />
        )}

        <div className="p-5 space-y-4">
          {/* Description */}
          {poi.description && (
            <p className="text-sm text-gray-600 leading-relaxed">
              {poi.description}
            </p>
          )}

          {/* Detail rows */}
          <div className="space-y-3">
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
                  {poi.website.replace(/^https?:\/\/(www\.)?/, '')}
                </a>
              </DetailRow>
            )}

            {poi.lat != null && poi.lng != null && (
              <DetailRow icon={<CoordIcon />} label="Coordinates">
                <span className="font-mono text-xs">
                  {poi.lat.toFixed(4)}, {poi.lng.toFixed(4)}
                </span>
              </DetailRow>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="text-gray-400 mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider mb-0.5">{label}</p>
        <div className="text-sm text-gray-700">{children}</div>
      </div>
    </div>
  );
}

function MapPinIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" />
    </svg>
  );
}

function CoordIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" /><path d="M12 2v4" /><path d="M12 18v4" /><path d="M2 12h4" /><path d="M18 12h4" />
    </svg>
  );
}
