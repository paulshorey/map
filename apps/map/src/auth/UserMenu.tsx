"use client";

import { useState, useRef, useEffect } from "react";
import { useAuth } from "./useAuth";

export function UserMenu() {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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

  if (loading || !user) return null;

  return (
    <div
      ref={menuRef}
      className="absolute bottom-[max(0.5rem,env(safe-area-inset-bottom,0px))] right-2 z-10 flex flex-col items-end"
    >
      {open && (
        <div className="mb-2 w-64 rounded-xl bg-white shadow-xl border border-gray-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100">
            <p className="text-sm font-medium text-gray-900">
              {user.displayName}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {user.isGuest
                ? "Browsing as guest — your preferences are saved automatically."
                : `${user.tier === "premium" ? "Premium" : "Free"} account`}
            </p>
          </div>
          <div className="p-2">
            <div className="px-3 py-2 text-xs text-gray-400">
              {user.isGuest
                ? "Sign in to sync preferences across devices and unlock premium map styles."
                : `Tier: ${user.tier}`}
            </div>
            {user.isGuest && (
              <button
                className="w-full text-left px-3 py-2 text-sm text-blue-600 hover:bg-blue-50 rounded-lg transition-colors cursor-pointer font-medium"
                onClick={() => {
                  alert(
                    "Authentication will be configured in a future update. Your guest preferences will be merged into your new account.",
                  );
                }}
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center rounded-lg bg-white p-2.5 text-gray-700 shadow-lg border border-gray-200 hover:bg-gray-50 transition-colors cursor-pointer"
        aria-label={user.isGuest ? "Guest account" : user.displayName}
      >
        <UserIcon />
      </button>
    </div>
  );
}

function UserIcon() {
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
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </svg>
  );
}
