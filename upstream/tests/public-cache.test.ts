import { beforeEach, describe, expect, it } from 'vitest';
import { bumpPublicCacheVersion, buildPublicCacheKey, getCachedJson } from '../src/public-site/cache';
import type { Env } from '../src/types';
import { clearSettingsCache } from '../src/utils';

function createEnv() {
  const settings = new Map<string, string>();
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          async all() {
            return {
              results: [...settings].map(([setting_key, setting_value]) => ({ setting_key, setting_value })),
            };
          },
          bind(key: string, value: string) {
            return {
              async run() {
                expect(sql).toContain('INSERT INTO site_settings');
                settings.set(key, value);
              },
            };
          },
        };
      },
    },
  } as unknown as Env;

  return { env, settings };
}

describe('public cache', () => {
  beforeEach(async () => {
    clearSettingsCache();
    // Reset the shared in-memory cache between tests.
    await bumpPublicCacheVersion(createEnv().env);
  });

  it('builds per-origin keys that ignore the request path', () => {
    expect(buildPublicCacheKey('https://blog.example/wp-json/wp/v2/pages/12', 'common')).toBe(
      buildPublicCacheKey('https://blog.example/', 'common'),
    );
    expect(buildPublicCacheKey('https://blog.example/', 'tag', 'cf')).not.toBe(
      buildPublicCacheKey('https://blog.example/', 'tag', 'other'),
    );
  });

  it('caches null results so missing slugs do not reload every time', async () => {
    const { env } = createEnv();
    const key = buildPublicCacheKey('https://blog.example/', 'category', 'missing');
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return null;
    };

    await expect(getCachedJson(env, key, 60, loader)).resolves.toBeNull();
    await expect(getCachedJson(env, key, 60, loader)).resolves.toBeNull();
    expect(loads).toBe(1);
  });

  it('skips caching when shouldCache rejects the value', async () => {
    const { env } = createEnv();
    const key = buildPublicCacheKey('https://blog.example/', 'post-list', { page: 999 });
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return { page: 1 };
    };

    await getCachedJson(env, key, 60, loader, (value) => value.page === 999);
    await getCachedJson(env, key, 60, loader, (value) => value.page === 999);
    expect(loads).toBe(2);
  });

  it('reloads after the cache version is bumped', async () => {
    const { env, settings } = createEnv();
    const key = buildPublicCacheKey('https://blog.example/', 'common');
    let loads = 0;
    const loader = async () => {
      loads += 1;
      return { loads };
    };

    await expect(getCachedJson(env, key, 60, loader)).resolves.toEqual({ loads: 1 });
    await expect(getCachedJson(env, key, 60, loader)).resolves.toEqual({ loads: 1 });

    await bumpPublicCacheVersion(env);
    expect(settings.get('public_cache_version')).toBeTruthy();

    await expect(getCachedJson(env, key, 60, loader)).resolves.toEqual({ loads: 2 });
  });
});
