import { apiFetch } from './client';

export type StatKey = 'posts' | 'pages' | 'comments' | 'categories' | 'tags' | 'media' | 'links' | 'users' | 'moments';

async function fetchCount(path: string, token: string): Promise<number> {
  const response = await apiFetch(path, {}, token);
  const total = response.headers.get('X-WP-Total');
  const count = total === null ? NaN : Number(total);
  if (Number.isFinite(count)) return count;
  const data = await response.json();
  return Array.isArray(data) ? data.length : 0;
}

export async function fetchDashboardStats(role: string, token = '') {
  const canModerate = ['administrator', 'editor'].includes(role);
  const endpoints: Record<StatKey, string[]> = {
    posts: ['/posts?per_page=1&status=all'],
    pages: ['/pages?per_page=1&status=all'],
    comments: canModerate
      ? ['/comments?per_page=1&status=all', '/moments/comments/all?per_page=1&status=all']
      : ['/comments?per_page=1&status=approved'],
    categories: ['/categories?per_page=1'],
    tags: ['/tags?per_page=1'],
    media: ['/media?per_page=1'],
    links: [`/links?per_page=1&visible=${canModerate ? 'all' : 'yes'}`],
    users: ['/users?per_page=1'],
    moments: ['/moments?per_page=1&status=all'],
  };
  const keys = Object.keys(endpoints) as StatKey[];
  const results = await Promise.allSettled(keys.map(async (key) => {
    const counts = await Promise.all(endpoints[key].map((path) => fetchCount(path, token)));
    return counts.reduce((sum, count) => sum + count, 0);
  }));
  const counts: Partial<Record<StatKey, number>> = {};
  const failedKeys: StatKey[] = [];
  results.forEach((result, index) => {
    const key = keys[index]!;
    if (result.status === 'fulfilled') counts[key] = result.value;
    else failedKeys.push(key);
  });
  return { counts, failedKeys };
}
