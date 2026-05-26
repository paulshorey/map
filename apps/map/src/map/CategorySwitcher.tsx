"use client";

import { useState, useRef, useEffect } from "react";

interface Props {
  category: string | null;
  categories: string[];
  isLoading: boolean;
  onSelect: (category: string | null) => void;
}

export function CategorySwitcher({
  category,
  categories,
  isLoading,
  onSelect,
}: Props) {
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
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  const handleSelect = (next: string | null) => {
    onSelect(next);
    setOpen(false);
  };

  return (
    <div ref={panelRef} className="absolute top-2 left-2 z-10">
      {open && (
        <div className="mt-2 w-64 rounded-xl bg-white shadow-xl border border-gray-200 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Categories
            </span>
          </div>
          <div className="max-h-80 overflow-y-auto py-1">
            {isLoading ? (
              <p className="px-3 py-2 text-sm text-gray-400">Loading…</p>
            ) : categories.length === 0 ? (
              <p className="px-3 py-2 text-sm text-gray-400">No categories</p>
            ) : (
              <>
                <CategoryOption
                  label="All"
                  active={category === null}
                  onSelect={() => handleSelect(null)}
                />
                {categories.map((c) => (
                  <CategoryOption
                    key={c}
                    label={c}
                    active={category === c}
                    onSelect={() => handleSelect(c)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm font-medium text-gray-700 shadow-lg border border-gray-200 hover:bg-gray-50 transition-colors cursor-pointer"
        aria-label={
          category ? `Category: ${category}` : "Filter POI categories"
        }
      >
        <TagIcon />
        <span className="hidden sm:inline truncate max-w-[12rem]">
          {category ?? "Categories"}
        </span>
      </button>
    </div>
  );
}

function CategoryOption({
  label,
  active,
  onSelect,
}: {
  label: string;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors cursor-pointer ${
        active
          ? "bg-blue-50 text-blue-700 font-medium"
          : "text-gray-700 hover:bg-gray-50"
      }`}
    >
      {active && (
        <span className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
      )}
      <span className="truncate flex-1">{label}</span>
    </button>
  );
}

function TagIcon() {
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
      <path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.41 0l7.59-7.59a1 1 0 0 0 0-1.41L12 2Z" />
      <path d="M7 7h.01" />
    </svg>
  );
}
