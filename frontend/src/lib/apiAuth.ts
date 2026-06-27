const STORAGE_KEY = "vibe_trading_api_auth_key";
const DEFAULT_KEY = "123456";

let _cachedKey: string | null = null;

export async function initApiAuthKey(): Promise<void> {
  // If user explicitly set a key in localStorage, always use it
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored !== null) {
    _cachedKey = stored;
    return;
  }
  // Try to fetch from backend /auth-config
  try {
    const res = await fetch("/auth-config");
    if (res.ok) {
      const data = await res.json();
      if (data.auth_required && data.key_hint) {
        // Backend has a key configured; use default since we can't know the full key
        _cachedKey = DEFAULT_KEY;
      } else {
        _cachedKey = "";
      }
      return;
    }
  } catch { /* ignore */ }
  // Fallback to default
  _cachedKey = DEFAULT_KEY;
}

export function getApiAuthKey(): string {
  if (_cachedKey !== null) return _cachedKey;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored !== null) {
    _cachedKey = stored;
    return stored;
  }
  return DEFAULT_KEY;
}

export function setApiAuthKey(value: string): void {
  const trimmed = value.trim();
  if (trimmed) {
    window.localStorage.setItem(STORAGE_KEY, trimmed);
    _cachedKey = trimmed;
  } else {
    window.localStorage.removeItem(STORAGE_KEY);
    _cachedKey = null;
  }
}

export function authHeaders(): Record<string, string> {
  const key = getApiAuthKey();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function authQuerySuffix(): string {
  const key = getApiAuthKey();
  return key ? `api_key=${encodeURIComponent(key)}` : "";
}

export function withAuthQuery(url: string): string {
  const suffix = authQuerySuffix();
  if (!suffix) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${suffix}`;
}
