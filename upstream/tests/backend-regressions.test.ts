import { DomUtils, parseDocument } from 'htmlparser2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import app from '../src/index';
import { createSqliteEnv, type SqliteEnv } from './helpers/sqlite-env';

const API = 'https://blog.example/wp-json/wp/v2';
let fixture: SqliteEnv;

beforeEach(async () => { fixture = await createSqliteEnv(); });
afterEach(async () => { await fixture.close(); });

async function request(path: string, init: RequestInit = {}) {
  return app.request(`${API}${path}`, init, fixture.env, fixture.executionCtx);
}

function jsonBody(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

function insertPost(id: number, status = 'publish', authorId = 1, content = '') {
  fixture.sqlite.prepare(`
    INSERT INTO posts (id, title, slug, status, author_id, content)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, `Post ${id}`, `post-${id}`, status, authorId, content);
}

function insertComment(id: number, postId: number, status = 'approved') {
  fixture.sqlite.prepare(`
    INSERT INTO comments (id, post_id, author_name, author_email, content, status)
    VALUES (?, ?, 'Guest', 'guest@example.com', ?, ?)
  `).run(id, postId, `Discussion ${id}`, status);
}

describe('bootstrap registration', () => {
  it('allows exactly one initial administrator when registration requests overlap', async () => {
    const responses = await Promise.all(['first', 'second'].map((username) => request('/users/register', jsonBody({
      username, email: `${username}@example.com`, password: 'secure-password-for-test',
    }))));

    expect(responses.map((response) => response.status).sort()).toEqual([201, 403]);
    expect(fixture.sqlite.prepare('SELECT role FROM users').all()).toEqual([{ role: 'administrator' }]);
    expect(await responses.find((response) => response.status === 403)!.json()).toMatchObject({ code: 'registration_closed' });
  });
});

describe('public article HTML', () => {
  it('overrides supplied link targets and relations while removing event handlers', async () => {
    fixture.insertUser(1);
    insertPost(1, 'publish', 1, '<a href="https://example.com/checked" target="_self" rel="opener" onclick="this.dataset.review=1">Checked link</a>');

    const response = await app.request('https://blog.example/post-1', {}, fixture.env, fixture.executionCtx);
    expect(response.status).toBe(200);
    const document = parseDocument(await response.text());
    const anchor = DomUtils.getElementsByTagName('a', document.children)
      .find((node) => node.attribs.href === 'https://example.com/checked');

    expect(anchor?.attribs).toEqual({
      href: 'https://example.com/checked', target: '_blank', rel: 'noopener noreferrer',
    });
  });

  it.each(['target', 'rel'])('preserves %s text in a title without creating event attributes', async (attribute) => {
    fixture.insertUser(1);
    const title = `${attribute}='value' onmouseover='this.dataset.review=1'`;
    insertPost(1, 'publish', 1, `<a href="https://example.com/checked" title="${title}">Checked link</a>`);

    const response = await app.request('https://blog.example/post-1', {}, fixture.env, fixture.executionCtx);
    expect(response.status).toBe(200);
    const document = parseDocument(await response.text());
    const anchor = DomUtils.getElementsByTagName('a', document.children)
      .find((node) => node.attribs.href === 'https://example.com/checked');

    expect(anchor?.attribs).toEqual({
      href: 'https://example.com/checked', title, target: '_blank', rel: 'noopener noreferrer',
    });
  });
});

describe('comments on non-public articles', () => {
  beforeEach(() => {
    fixture.insertUser(1, 'author');
    fixture.insertUser(2, 'author');
    fixture.insertUser(3, 'editor');
    ['private', 'draft', 'pending', 'trash', 'publish'].forEach((status, index) => {
      insertPost(index + 1, status);
      insertComment(index + 1, index + 1);
    });
  });

  it('filters both anonymous comment results and pagination totals by article visibility', async () => {
    const response = await request('/comments');
    expect(response.status).toBe(200);
    expect(response.headers.get('X-WP-Total')).toBe('1');
    expect((await response.json() as Array<{ id: number }>).map((comment) => comment.id)).toEqual([5]);

    const filtered = await request('/comments?post=1');
    expect(filtered.headers.get('X-WP-Total')).toBe('0');
    expect(await filtered.json()).toEqual([]);
  });

  it.each([1, 2, 3, 4])('rejects anonymous detail and creation for non-public article %i', async (id) => {
    expect((await request(`/comments/${id}`)).status).toBe(404);
    const response = await request('/comments', jsonBody({
      post: id, author_name: 'Guest', author_email: 'new@example.com', content: 'New discussion',
    }));
    expect(response.status).toBe(404);
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM comments').get()).toEqual({ count: 5 });
  });

  it('allows owners and editors to read approved comments on private articles', async () => {
    for (const userId of [1, 3]) {
      const headers = await fixture.authHeaders(userId);
      const detail = await request('/comments/1', { headers });
      expect(detail.status).toBe(200);
      const list = await request('/comments?post=1', { headers });
      expect(list.headers.get('X-WP-Total')).toBe('1');
      expect(await list.json()).toMatchObject([{ id: 1 }]);
    }
    const otherAuthor = await fixture.authHeaders(2);
    expect((await request('/comments/1', { headers: otherAuthor })).status).toBe(404);
    expect(await (await request('/comments?post=1', { headers: otherAuthor })).json()).toEqual([]);
  });

  it('allows an owner to comment on their private article while blocking other authors', async () => {
    const body = { post: 1, content: 'Owner discussion' };
    expect((await request('/comments', jsonBody(body, await fixture.authHeaders(2)))).status).toBe(404);
    expect((await request('/comments', jsonBody(body, await fixture.authHeaders(1)))).status).toBe(201);
  });
});

describe('category reassignment', () => {
  it('merges duplicate default memberships, reparents children and updates the count', async () => {
    fixture.insertUser(1);
    insertPost(1);
    insertPost(2);
    fixture.sqlite.exec(`
      INSERT INTO categories (id, name, slug, parent_id) VALUES (2, 'Other', 'other', 0), (3, 'Child', 'child', 2);
      INSERT INTO post_categories (post_id, category_id) VALUES (1, 1), (1, 2), (2, 2);
    `);

    const response = await request('/categories/2?force=true', {
      method: 'DELETE', headers: await fixture.authHeaders(1),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: true });
    expect(fixture.sqlite.prepare('SELECT * FROM post_categories ORDER BY post_id').all()).toEqual([
      { post_id: 1, category_id: 1 }, { post_id: 2, category_id: 1 },
    ]);
    expect(fixture.sqlite.prepare('SELECT count FROM categories WHERE id = 1').get()).toEqual({ count: 2 });
    expect(fixture.sqlite.prepare('SELECT parent_id FROM categories WHERE id = 3').get()).toEqual({ parent_id: 0 });
    expect(fixture.sqlite.prepare('SELECT id FROM categories WHERE id = 2').get()).toBeUndefined();
  });
});

describe('page slugs', () => {
  beforeEach(() => { fixture.insertUser(1); });

  it('assigns distinct usable addresses to Chinese titles when the slug is omitted', async () => {
    const headers = await fixture.authHeaders(1);
    const slugs = [];
    for (const title of ['关于我们', '联系方式', '关于我们']) {
      const response = await request('/pages', jsonBody({ title, status: 'publish' }, headers));
      expect(response.status).toBe(201);
      const page = await response.json() as { slug: string };
      expect(page.slug).toMatch(/^[a-z0-9-]+$/);
      slugs.push(page.slug);
      expect((await app.request(`https://blog.example/${page.slug}`, {}, fixture.env, fixture.executionCtx)).status).toBe(200);
    }
    expect(new Set(slugs).size).toBe(3);
  });

  it('avoids existing article slugs when generating a page address', async () => {
    fixture.sqlite.prepare('INSERT INTO posts (title, slug, status, author_id) VALUES (?, ?, ?, ?)')
      .run('Existing post', 'page', 'publish', 1);
    const response = await request('/pages', jsonBody({ title: '关于我们' }, await fixture.authHeaders(1)));
    expect(response.status).toBe(201);
    const page = await response.json() as { slug: string };
    expect(page.slug).not.toBe('page');
    expect(page.slug.length).toBeGreaterThan(0);
  });

  it('rejects explicit page addresses that collide with an article on create or update', async () => {
    insertPost(1);
    const headers = await fixture.authHeaders(1);
    const rejected = await request('/pages', jsonBody({ title: 'Page', slug: 'post-1' }, headers));
    expect(rejected.status).toBe(400);
    const created = await request('/pages', jsonBody({ title: 'Page', slug: 'separate-page' }, headers));
    const page = await created.json() as { id: number };
    const updated = await request(`/pages/${page.id}`, {
      ...jsonBody({ slug: 'post-1' }, headers), method: 'PUT',
    });
    expect(updated.status).toBe(400);
    expect(fixture.sqlite.prepare('SELECT slug FROM posts WHERE id = ?').get(page.id)).toEqual({ slug: 'separate-page' });
  });

  it('repairs an existing empty page address when saving an empty slug', async () => {
    fixture.sqlite.prepare(`INSERT INTO posts (id, title, slug, post_type, author_id) VALUES (1, '旧页面', '', 'page', 1)`).run();
    const response = await request('/pages/1', {
      ...jsonBody({ title: '关于我们', slug: '' }, await fixture.authHeaders(1)), method: 'PUT',
    });
    expect(response.status).toBe(200);
    expect((await response.json() as { slug: string }).slug.length).toBeGreaterThan(0);
  });
});

describe('moment comment visibility and rate limits', () => {
  beforeEach(() => {
    fixture.insertUser(1, 'author');
    fixture.insertUser(2, 'author');
    fixture.sqlite.exec(`INSERT INTO moments (id, content, author_id, status) VALUES (1, 'Moment', 1, 'publish'), (2, 'Draft', 1, 'draft')`);
  });

  const comment = { author_name: 'Guest', author_email: 'new@example.com', content: 'First comment' };
  const ipHeaders = { 'CF-Connecting-IP': '192.0.2.1' };

  it('blocks anonymous and unrelated users from commenting on unpublished moments', async () => {
    expect((await request('/moments/2/comments', jsonBody(comment))).status).toBe(404);
    expect((await request('/moments/2/comments', jsonBody(comment, await fixture.authHeaders(2)))).status).toBe(404);
    expect((await request('/moments/2/comments', jsonBody(comment, await fixture.authHeaders(1)))).status).toBe(201);
  });

  it('rejects a second submission from the same IP inside the configured window', async () => {
    expect((await request('/moments/1/comments', jsonBody(comment, ipHeaders))).status).toBe(201);
    const response = await request('/moments/1/comments', jsonBody({ ...comment, content: 'Different comment' }, ipHeaders));
    expect(response.status).toBe(429);
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM moment_comments').get()).toEqual({ count: 1 });
  });

  it.each(['sqlite', 'iso'])('includes existing %s timestamps in IP rate limits', async (format) => {
    const timestamp = new Date().toISOString();
    fixture.sqlite.prepare(`
      INSERT INTO moment_comments (moment_id, author_name, author_email, author_ip, content, created_at)
      VALUES (1, 'Guest', 'earlier@example.com', ?, 'Earlier comment', ?)
    `).run(ipHeaders['CF-Connecting-IP'], format === 'sqlite' ? timestamp.slice(0, 19).replace('T', ' ') : timestamp);
    expect((await request('/moments/1/comments', jsonBody(comment, ipHeaders))).status).toBe(429);
  });

  it.each(['sqlite', 'iso'])('includes existing %s timestamps in email rate limits', async (format) => {
    const timestamp = new Date().toISOString();
    const createdAt = format === 'sqlite' ? timestamp.slice(0, 19).replace('T', ' ') : timestamp;
    for (let index = 0; index < 3; index += 1) {
      fixture.sqlite.prepare(`
        INSERT INTO moment_comments (moment_id, author_name, author_email, author_ip, content, created_at)
        VALUES (1, 'Guest', ?, ?, ?, ?)
      `).run(comment.author_email, `192.0.2.${index + 2}`, `Earlier comment ${index}`, createdAt);
    }
    expect((await request('/moments/1/comments', jsonBody(comment, ipHeaders))).status).toBe(429);
  });

  it('allows comments after rate-limit windows have expired', async () => {
    fixture.sqlite.prepare(`
      INSERT INTO moment_comments (moment_id, author_name, author_email, author_ip, content, created_at)
      VALUES (1, 'Guest', ?, ?, 'Old comment', ?)
    `).run(comment.author_email, ipHeaders['CF-Connecting-IP'], new Date(Date.now() - 11 * 60 * 1000).toISOString());
    expect((await request('/moments/1/comments', jsonBody(comment, ipHeaders))).status).toBe(201);
  });

  it.each(['sqlite', 'iso'])('rejects duplicate comments within 24 hours using existing %s timestamps', async (format) => {
    const timestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    fixture.sqlite.prepare(`
      INSERT INTO moment_comments (moment_id, author_name, author_email, author_ip, content, created_at)
      VALUES (1, 'Guest', ?, ?, ?, ?)
    `).run(comment.author_email, ipHeaders['CF-Connecting-IP'], comment.content,
      format === 'sqlite' ? timestamp.slice(0, 19).replace('T', ' ') : timestamp);

    const response = await request('/moments/1/comments', jsonBody(comment, ipHeaders));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'rest_comment_rejected', message: '请勿重复提交相同评论。' });
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM moment_comments').get()).toEqual({ count: 1 });
  });

  it.each(['sqlite', 'iso'])('allows the same content after 24 hours using existing %s timestamps', async (format) => {
    const timestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    fixture.sqlite.prepare(`
      INSERT INTO moment_comments (moment_id, author_name, author_email, author_ip, content, created_at)
      VALUES (1, 'Guest', ?, ?, ?, ?)
    `).run(comment.author_email, ipHeaders['CF-Connecting-IP'], comment.content,
      format === 'sqlite' ? timestamp.slice(0, 19).replace('T', ' ') : timestamp);

    expect((await request('/moments/1/comments', jsonBody(comment, ipHeaders))).status).toBe(201);
    expect(fixture.sqlite.prepare('SELECT COUNT(*) AS count FROM moment_comments').get()).toEqual({ count: 2 });
  });
});
