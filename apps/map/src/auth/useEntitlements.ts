import { PROVIDERS } from '../basemap/providers';
import { useAuth } from './useAuth';

const FREE_PROVIDER_IDS = PROVIDERS
  .filter((p) => p.tier === 'free')
  .map((p) => p.id);

export function useEntitlements() {
  const { user } = useAuth();

  if (user) {
    return {
      tier: user.tier,
      allowedProviderIds: user.allowedProviders,
    };
  }

  return {
    tier: 'free' as const,
    allowedProviderIds: FREE_PROVIDER_IDS,
  };
}
