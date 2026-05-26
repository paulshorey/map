# lib/

Shared utilities used across app, auth, map, and basemap modules. Not feature UI — keep helpers small and generic.

## Files

| File | Role |
| --- | --- |
| `config.ts` | `apiUrl()` — prefixes paths with `NEXT_PUBLIC_API_URL` for Capacitor remote API |
| `auth.ts` | **Server-side** guest user ID and tier-based provider allowlists |
| `useDebouncedValue.ts` | Generic debounce hook (POI bbox fetch, viewport save) |
| `platform/detect.ts` | Capacitor platform flags (`isNative`, `isIOS`, `isWeb`, …) |

## `apiUrl()` — important for mobile

Web builds use relative paths (`/api/pois`). Capacitor static builds point at a deployed backend via `NEXT_PUBLIC_API_URL`. All client fetches should go through `apiUrl()`, not raw `/api/...` strings.

## `auth.ts` vs `auth/` folder

| Location | Runs on | Contents |
| --- | --- | --- |
| `lib/auth.ts` | Server (API routes) | `resolveUserId()`, `allowedProvidersForTier()` |
| `auth/` folder | Client (React) | Context, hooks, UI |

When adding real authentication, `resolveUserId()` is the primary server hook to change. Client `AuthProvider` will need matching session/cookie handling.

## Quirks

- Provider allowlists are duplicated conceptually with `basemap/providers.ts` tiers — server list in `lib/auth.ts` is authoritative for API enforcement.
- `useDebouncedValue` delay values differ by caller (250ms bbox, 2000ms viewport prefs).
