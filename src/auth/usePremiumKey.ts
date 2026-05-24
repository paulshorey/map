import { useQuery } from '@tanstack/react-query';
import { PROVIDERS } from '../basemap/providers';
import { useAuth } from './useAuth';

export function usePremiumKey(providerId: string): string | null {
  const { user } = useAuth();
  const provider = PROVIDERS.find((p) => p.id === providerId);
  const isPremiumProvider = provider?.tier === 'premium';
  const isPremiumUser = user?.tier === 'premium';

  const { data } = useQuery({
    queryKey: ['provider-credentials', providerId],
    queryFn: async () => {
      const r = await fetch(`/api/providers/${providerId}/credentials`);
      if (!r.ok) return null;
      const json = await r.json();
      return (json.apiKey as string) ?? null;
    },
    enabled: isPremiumProvider && isPremiumUser,
    staleTime: 5 * 60_000,
  });

  return data ?? null;
}
