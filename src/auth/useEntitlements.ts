import { PROVIDERS } from '../basemap/providers';

const FREE_PROVIDER_IDS = PROVIDERS
  .filter((p) => p.tier === 'free')
  .map((p) => p.id);

/**
 * Stub entitlements hook. When auth is wired up (Phase 6), this will call
 * GET /me and return real tier + allowed providers. For now, all free
 * providers are unlocked and premium providers are locked.
 */
export function useEntitlements() {
  return {
    tier: 'free' as const,
    allowedProviderIds: FREE_PROVIDER_IDS,
  };
}
