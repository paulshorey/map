import { useState, useRef, useEffect } from 'react';
import { useBasemap, type ProviderWithLock } from './useBasemap';

export function BasemapSwitcher() {
  const { providerId, switchProvider, allProviders } = useBasemap();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const freeProviders = allProviders.filter((p) => p.tier === 'free');
  const premiumProviders = allProviders.filter((p) => p.tier === 'premium');

  return (
    <div
      ref={panelRef}
      className="absolute bottom-6 left-3 z-10"
    >
      {open && (
        <div className="mb-2 w-64 rounded-xl bg-white shadow-xl border border-gray-200 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Basemap
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto">
            <ProviderGroup
              label="Free"
              providers={freeProviders}
              activeId={providerId}
              onSelect={switchProvider}
            />
            {premiumProviders.length > 0 && (
              <ProviderGroup
                label="Premium"
                providers={premiumProviders}
                activeId={providerId}
                onSelect={switchProvider}
              />
            )}
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-lg border border-gray-200 hover:bg-gray-50 transition-colors cursor-pointer"
        aria-label="Switch basemap"
      >
        <LayersIcon />
        <span className="hidden sm:inline">Basemap</span>
      </button>
    </div>
  );
}

function ProviderGroup({
  label,
  providers,
  activeId,
  onSelect,
}: {
  label: string;
  providers: ProviderWithLock[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="py-1">
      <div className="px-3 py-1">
        <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
          {label}
        </span>
      </div>
      {providers.map((p) => (
        <button
          key={p.id}
          onClick={() => !p.locked && onSelect(p.id)}
          disabled={p.locked}
          className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors cursor-pointer ${
            p.id === activeId
              ? 'bg-blue-50 text-blue-700 font-medium'
              : p.locked
                ? 'text-gray-400 cursor-not-allowed'
                : 'text-gray-700 hover:bg-gray-50'
          }`}
        >
          {p.id === activeId && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
          )}
          <span className="truncate flex-1">{p.label}</span>
          {p.locked && <span className="text-xs shrink-0">&#128274;</span>}
        </button>
      ))}
    </div>
  );
}

function LayersIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 2 2 7l10 5 10-5-10-5Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </svg>
  );
}
