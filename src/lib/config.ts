function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Remote API origin for Capacitor builds. Empty string = same-origin (web). */
export function getApiBaseUrl(): string {
  return stripTrailingSlashes(process.env.NEXT_PUBLIC_API_URL ?? '');
}

export function apiUrl(path: string): string {
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return base ? `${base}${normalizedPath}` : normalizedPath;
}
