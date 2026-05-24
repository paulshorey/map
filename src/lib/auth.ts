const FREE_PROVIDERS = [
  'openfreemap-liberty',
  'openfreemap-positron',
  'openfreemap-bright',
  'stadia-outdoors',
  'stamen-terrain',
  'alidade-satellite',
  'alidade-smooth',
  'carto-voyager',
  'carto-positron',
  'carto-dark-matter',
  'opentopomap',
];

const PREMIUM_EXTRAS = [
  'thunderforest-outdoors',
  'thunderforest-landscape',
];

export function resolveUserId(): string {
  // When real auth is wired, extract user ID from JWT/session cookie here.
  return 'guest';
}

export function allowedProvidersForTier(tier: string): string[] {
  return tier === 'premium'
    ? [...FREE_PROVIDERS, ...PREMIUM_EXTRAS]
    : FREE_PROVIDERS;
}
