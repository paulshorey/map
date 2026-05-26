import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiUrl } from '@/lib/config';

const LS_KEY = 'poi.category';

function readInitial(): string | null {
  const ls = localStorage.getItem(LS_KEY);
  return ls || null;
}

export function usePoiCategory() {
  const [category, setCategory] = useState<string | null>(() => readInitial());

  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['poi-categories'],
    queryFn: async () => {
      const r = await fetch(apiUrl('/api/pois/categories'));
      if (!r.ok) throw new Error('Failed to load categories');
      const json = (await r.json()) as { categories: string[] };
      return json.categories;
    },
    staleTime: 300_000,
  });

  const selectCategory = useCallback((next: string | null) => {
    setCategory(next);
    if (next) {
      localStorage.setItem(LS_KEY, next);
    } else {
      localStorage.removeItem(LS_KEY);
    }
  }, []);

  return {
    category,
    categories,
    isLoading,
    selectCategory,
  };
}
