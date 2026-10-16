import type { Env } from '../types';
import { clearSettingsCache, getSiteSettings, normalizeBaseUrl } from '../utils';

// Public pages are cached in isolate memory and the Cache API (both free and unmetered),
// instead of KV whose free tier only allows 1,000 writes per day.
// Every key embeds a version stored in site_settings; bumping it invalidates all colos at once.
export const PUBLIC_CACHE_VERSION_SETTING = 'public_cache_version';
export const PUBLIC_COMMON_CACHE_TTL_SECONDS = 300;
export const PUBLIC_RSS_CACHE_TTL_SECONDS = 900;
export const PUBLIC_SITEMAP_CACHE_TTL_SECONDS = 3600;

const MEMORY_CACHE_LIMIT = 200;
const memoryCache = new Map<string, { expiresAt: number; payload: string }>();

interface CachedPayload<T> {
  expiresAt: number;
  value: T;
}

export function buildPublicCacheKey(requestUrl: string, name: string, ...parts: unknown[]): string {
  const url = new URL(`/_cfblog/cache/${encodeURIComponent(name)}`, normalizeBaseUrl(new URL(requestUrl).origin));
  if (parts.length) {
    url.searchParams.set(
      'k',
      parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(':'),
    );
  }
  return url.toString();
}

async function getPublicCacheVersion(env: Env): Promise<string> {
  const settings = await getSiteSettings(env);
  return String(settings[PUBLIC_CACHE_VERSION_SETTING] || '0');
}

function getEdgeCache(): Cache | null {
  return typeof caches !== 'undefined' && 'default' in caches
    ? (caches as unknown as { default: Cache }).default
    : null;
}

function rememberInMemory(key: string, payload: string, expiresAt: number): void {
  memoryCache.delete(key);
  if (memoryCache.size >= MEMORY_CACHE_LIMIT) {
    const oldestKey = memoryCache.keys().next().value;
    if (oldestKey !== undefined) {
      memoryCache.delete(oldestKey);
    }
  }
  memoryCache.set(key, { expiresAt, payload });
}

export async function getCachedJson<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  shouldCache: (value: T) => boolean = () => true,
): Promise<T> {
  const cacheUrl = new URL(key);
  cacheUrl.searchParams.set('v', await getPublicCacheVersion(env));
  const cacheKey = cacheUrl.toString();
  const now = Date.now();

  const memoryHit = memoryCache.get(cacheKey);
  if (memoryHit && memoryHit.expiresAt > now) {
    return (JSON.parse(memoryHit.payload) as CachedPayload<T>).value;
  }

  const edgeCache = getEdgeCache();
  if (edgeCache) {
    try {
      const response = await edgeCache.match(cacheKey);
      if (response) {
        const payload = await response.text();
        const cached = JSON.parse(payload) as CachedPayload<T>;
        if (cached.expiresAt > now) {
          rememberInMemory(cacheKey, payload, cached.expiresAt);
          return cached.value;
        }
      }
    } catch (error) {
      console.error('Public cache read failed:', error);
    }
  }

  const value = await loader();
  if (!shouldCache(value)) {
    return value;
  }

  const expiresAt = now + ttlSeconds * 1000;
  const payload = JSON.stringify({ expiresAt, value } satisfies CachedPayload<T>);
  rememberInMemory(cacheKey, payload, expiresAt);

  if (edgeCache) {
    try {
      await edgeCache.put(
        cacheKey,
        new Response(payload, {
          headers: {
            'Cache-Control': `public, max-age=${ttlSeconds}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
        }),
      );
    } catch (error) {
      console.error('Public cache write failed:', error);
    }
  }

  return value;
}

export async function bumpPublicCacheVersion(env: Env): Promise<void> {
  memoryCache.clear();

  try {
    await env.DB.prepare(`
      INSERT INTO site_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = CURRENT_TIMESTAMP
    `).bind(PUBLIC_CACHE_VERSION_SETTING, Date.now().toString(36)).run();
  } catch (error) {
    console.error('Failed to bump public cache version:', error);
  }

  clearSettingsCache();
}
