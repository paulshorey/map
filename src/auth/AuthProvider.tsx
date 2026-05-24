import {
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import type { User, UserPreferences } from './types';
import { AuthContext } from './AuthContext';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const userRef = useRef<User | null>(null);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch('/api/me');
        if (!res.ok) throw new Error('Failed to load user');
        const data: User = await res.json();
        if (!cancelled) setUser(data);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const updatePreferences = useCallback(
    (prefs: Partial<UserPreferences>) => {
      const current = userRef.current;
      if (!current) return;
      const merged = { ...current.preferences, ...prefs };
      setUser((prev) => prev ? { ...prev, preferences: merged } : prev);

      fetch('/api/me/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      }).catch(() => {});
    },
    [],
  );

  return (
    <AuthContext.Provider value={{ user, loading, updatePreferences }}>
      {children}
    </AuthContext.Provider>
  );
}
