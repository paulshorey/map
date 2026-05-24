import { useState, useCallback } from 'react';
import {
  PROVIDERS,
  DEFAULT_PROVIDER_ID,
  getProvider,
  type BasemapProvider,
} from './providers';
import { useAuth } from '../auth/useAuth';
import { useEntitlements } from '../auth/useEntitlements';

const LS_KEY = 'basemap.providerId';
const QS_KEY = 'basemap';

function readInitial(allowedIds: string[], serverBasemapId: string | null): string {
  const qs = new URLSearchParams(location.search).get(QS_KEY);
  if (qs && PROVIDERS.some((p) => p.id === qs) && allowedIds.includes(qs))
    return qs;
  const ls = localStorage.getItem(LS_KEY);
  if (ls && PROVIDERS.some((p) => p.id === ls) && allowedIds.includes(ls))
    return ls;
  if (serverBasemapId && PROVIDERS.some((p) => p.id === serverBasemapId) && allowedIds.includes(serverBasemapId))
    return serverBasemapId;
  return DEFAULT_PROVIDER_ID;
}

export interface ProviderWithLock extends BasemapProvider {
  locked: boolean;
}

export function useBasemap() {
  const { user, updatePreferences } = useAuth();
  const { allowedProviderIds } = useEntitlements();

  const [providerId] = useState<string>(() =>
    readInitial(allowedProviderIds, user?.preferences.basemapId ?? null),
  );

  const switchProvider = useCallback(
    (next: string) => {
      if (!allowedProviderIds.includes(next)) return;
      localStorage.setItem(LS_KEY, next);
      updatePreferences({ basemapId: next });
      const url = new URL(location.href);
      url.searchParams.set(QS_KEY, next);
      location.assign(url.toString());
    },
    [allowedProviderIds, updatePreferences],
  );

  const allProviders: ProviderWithLock[] = PROVIDERS.map((p) => ({
    ...p,
    locked: !allowedProviderIds.includes(p.id),
  }));

  return {
    provider: getProvider(providerId),
    providerId,
    switchProvider,
    allProviders,
  };
}
