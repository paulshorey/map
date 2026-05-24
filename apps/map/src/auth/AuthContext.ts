import { createContext } from 'react';
import type { User, UserPreferences } from './types';

export interface AuthContextValue {
  user: User | null;
  loading: boolean;
  updatePreferences: (prefs: Partial<UserPreferences>) => void;
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  updatePreferences: () => {},
});
