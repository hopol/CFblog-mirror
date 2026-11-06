import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiAllPages, ApiError } from '../admin/src/api/client';
import { fetchDashboardStats } from '../admin/src/api/dashboard';

afterEach(() => vi.unstubAllGlobals());

describe('editor paginated options', () => {
  it.each(['/categories', '/tags', '/pages?status=all'])('loads every page of %s and preserves filters and authentication', async (path) => {
    const fetch = vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input, 'https://blog.test');
      const page = Number(url.searchParams.get('page'));
      expect(url.searchParams.get('per_page')).toBe('100');
      if (path.startsWith('/pages')) expect(url.searchParams.get('status')).toBe('all');
      expect(new Headers(init.headers).get('Authorization')).toBe('Bearer test-token');
      expect(init.credentials).toBe('same-origin');
      const count = page < 3 ? 100 : 5;
      return Response.json(Array.from({ length: count }, (_, index) => ({ id: (page - 1) * 100 + index + 1 })), {
        headers: { 'X-WP-TotalPages': '3' },
      });
    });
    vi.stubGlobal('fetch', fetch);

    const items = await apiAllPages<{ id: number }>(path, 'test-token');
    expect(items).toHaveLength(205);
    expect(items.map((item) => item.id)).toEqual(Array.from({ length: 205 }, (_, index) => index + 1));
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reports a later page failure instead of returning incomplete options', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json([{ id: 1 }], { headers: { 'X-WP-TotalPages': '2' } }))
      .mockResolvedValueOnce(Response.json({ message: 'Database unavailable' }, { status: 503 })));
    await expect(apiAllPages('/tags')).rejects.toMatchObject({ status: 503, message: 'Database unavailable' });
  });
});

describe('dashboard permissions and partial failures', () => {
  it.each(['author', 'contributor', 'subscriber'])('does not request moderator-only counts for %s', async (role) => {
    const fetch = vi.fn(async (input: string) => {
      if (input.includes('/moments/comments/all')) {
        return Response.json({ message: 'Forbidden' }, { status: 403 });
      }
      return Response.json([], { headers: { 'X-WP-Total': '4' } });
    });
    vi.stubGlobal('fetch', fetch);
    const result = await fetchDashboardStats(role);

    expect(result.failedKeys).toEqual([]);
    expect(result.counts.posts).toBe(4);
    expect(result.counts.comments).toBe(4);
    expect(fetch.mock.calls.some(([path]) => path.includes('/moments/comments/all'))).toBe(false);
    expect(fetch.mock.calls.some(([path]) => path.includes('/comments?per_page=1&status=approved'))).toBe(true);
  });

  it.each(['administrator', 'editor'])('includes all comment sources for %s', async (role) => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => Response.json([], {
      headers: { 'X-WP-Total': input.includes('/moments/comments/all') ? '3' : '7' },
    })));
    const result = await fetchDashboardStats(role);
    expect(result.counts.comments).toBe(10);
    expect(result.failedKeys).toEqual([]);
  });

  it('keeps successful counts while reporting failed resources', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      if (input.includes('/tags?')) return Response.json({ message: 'Unavailable' }, { status: 503 });
      if (input.includes('/media?')) throw new ApiError('Session expired', 401);
      return Response.json([], { headers: { 'X-WP-Total': '9' } });
    }));
    const result = await fetchDashboardStats('administrator');
    expect(result.failedKeys).toEqual(['tags', 'media']);
    expect(result.counts).toMatchObject({ posts: 9, pages: 9, comments: 18, moments: 9 });
    expect(result.counts).not.toHaveProperty('tags');
    expect(result.counts).not.toHaveProperty('media');
  });

  it('uses the returned collection when the total header is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 1 }, { id: 2 }])));
    expect((await fetchDashboardStats('author')).counts.posts).toBe(2);
  });
});
