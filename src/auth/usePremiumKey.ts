import { PROVIDERS } from '../basemap/providers';

/**
 * Stub premium key hook. When auth is wired up (Phase 7), this will
 * lazily fetch credentials from GET /providers/:id/credentials for
 * premium providers. Returns null for free providers.
 */
export function usePremiumKey(providerId: string): string | null {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider || provider.tier === 'free') return null;
  // TODO: fetch from /providers/:id/credentials when auth is wired
  return null;
}
