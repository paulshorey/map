# auth/

Client-side user session and premium entitlements. No real login yet — everyone is the guest user from the database.

## Files

| File | Role |
| --- | --- |
| `AuthProvider.tsx` | Fetches `/api/me` on mount; exposes user state and `updatePreferences` |
| `AuthContext.ts` | React context definition |
| `useAuth.ts` | Hook to read auth context |
| `useEntitlements.ts` | Derives allowed basemap provider IDs from user tier |
| `usePremiumKey.ts` | Fetches tile API keys for premium providers via `/api/providers/.../credentials` |
| `UserMenu.tsx` | Header UI showing user name/tier |
| `types.ts` | Client `User`, `UserPreferences`, `UserTier` types |

## Server-side counterpart

Server routes use `@/lib/auth.ts` (different file):

- `resolveUserId()` — returns `'guest'` until real auth is wired
- `allowedProvidersForTier(tier)` — free vs premium provider ID lists

Keep client tier logic in sync with server lists when adding providers.

## Preference persistence

`updatePreferences` optimistically merges into local state, then PATCHes `/api/me/preferences`. Used for:

- `basemapId` — chosen tile provider
- `lastCenter` / `lastZoom` — debounced viewport save from `MapView`

Basemap switches also write to `localStorage` and reload with `?basemap=` query param (see `basemap/useBasemap.ts`).

## Quirks

- `useEntitlements` falls back to free-tier providers when `user` is null (during load or on error).
- Premium keys are only fetched when both the provider and user are premium tier.
- API response types should match `UserSessionResponse` in `@lib/db-map/contracts/map-app`.
