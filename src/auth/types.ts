export type UserTier = 'free' | 'premium';

export interface User {
  id: string;
  displayName: string;
  tier: UserTier;
  allowedProviders: string[];
  preferences: UserPreferences;
  isGuest: boolean;
}

export interface UserPreferences {
  basemapId: string | null;
  lastCenter: [number, number] | null;
  lastZoom: number | null;
}

export const GUEST_USER_ID = 'guest';
