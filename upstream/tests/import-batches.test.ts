import { describe, expect, it } from 'vitest';
import { createImportBatches, type ImportContentItem, type ImportPackage } from '../admin/src/import-batches';

describe('admin import batches', () => {
  it('imports parents before children even when the original parent falls in a later batch', () => {
    const content: ImportContentItem[] = [
      { type: 'page', slug: 'child', parent_slug: 'parent', title: 'Child' },
      ...Array.from({ length: 19 }, (_, index) => ({ type: 'post', slug: `post-${index}`, title: `Post ${index}` })),
      { type: 'page', slug: 'parent', title: 'Parent' },
    ];
    const pkg: ImportPackage = { format: 'cfblog-import', version: '1.1', content };
    const snapshot = JSON.stringify(pkg);
    const batches = createImportBatches(pkg);
    const importedPages = new Set<string>();
    for (const batch of batches) {
      expect(batch.content!.length).toBeLessThanOrEqual(20);
      for (const item of batch.content!) if (item.type === 'page') importedPages.add(item.slug!);
      for (const item of batch.content!) {
        if (item.parent_slug) expect(importedPages.has(item.parent_slug)).toBe(true);
      }
    }
    expect(batches).toHaveLength(2);
    expect(batches.flatMap((batch) => batch.content!)).toHaveLength(21);
    expect(JSON.stringify(pkg)).toBe(snapshot);
  });

  it('handles ancestors spanning multiple batches without dropping content or metadata', () => {
    const content = Array.from({ length: 65 }, (_, index) => ({
      type: 'page', slug: `page-${index}`, title: `Page ${index}`,
      ...(index < 64 ? { parent_slug: `page-${index + 1}` } : {}),
      source: { id: index },
    }));
    const source = { platform: 'wordpress', site_url: 'https://old.test' };
    const categories = [{ slug: 'category' }];
    const tags = [{ slug: 'tag' }];
    const moments = Array.from({ length: 25 }, (_, index) => ({ content: `Moment ${index}` }));
    const batches = createImportBatches({ source, content, categories, tags, moments });

    expect(batches.map((batch) => batch.content!.length + batch.moments!.length)).toEqual([20, 20, 20, 5, 20, 5]);
    expect(batches.flatMap((batch) => batch.content!)).toEqual([...content].reverse());
    expect(batches.flatMap((batch) => batch.moments!)).toEqual(moments);
    expect(batches[0]).toMatchObject({ source, categories, tags });
    expect(batches.slice(1).every((batch) => batch.source === source && !batch.categories!.length && !batch.tags!.length)).toBe(true);
  });

  it.each([
    { parent: { title: 'Parent page' }, expectedSlug: 'parent-page' },
    { parent: { title: 'Parent', slug: 'Parent_PAGE!' }, expectedSlug: 'parent-page' },
    { parent: { title: '中文父页' }, expectedSlug: 'page-21' },
  ])('resolves title-derived, normalized and positional parent slug $expectedSlug before splitting', ({ parent, expectedSlug }) => {
    const content = [
      { type: 'page', title: 'Child', slug: 'child', parent_slug: expectedSlug },
      ...Array.from({ length: 19 }, (_, index) => ({ type: 'post', title: `Post ${index}` })),
      { type: 'page', ...parent },
    ];
    const batches = createImportBatches({ content });
    expect(batches[0]!.content!.slice(0, 2).map((item) => item.slug)).toEqual([expectedSlug, 'child']);
    expect(batches.flatMap((batch) => batch.content!).filter((item) => item.type === 'post').map((item) => item.slug))
      .toEqual(Array.from({ length: 19 }, (_, index) => `post-${index}`));
  });

  it('keeps positional fallback identities when unrelated items move across batches', () => {
    const content = Array.from({ length: 45 }, (_, index) => ({ type: 'post', title: `中文${'文'.repeat(index)}` }));
    const result = createImportBatches({ content }).flatMap((batch) => batch.content!);
    expect(result.map((item) => item.slug)).toEqual(Array.from({ length: 45 }, (_, index) => `post-${index + 1}`));
  });

  it('treats non-string fields the same as the import API without throwing', () => {
    const content = [
      { type: 123, title: 'Post title', slug: 456 },
      { type: 'page', title: 'Page title', slug: false, parent_slug: 789 },
      { type: null, title: 123, slug: {} },
    ] as unknown as ImportContentItem[];
    const result = createImportBatches({ content }).flatMap((batch) => batch.content!);
    expect(result.map((item) => item.slug)).toEqual(['post-title', 'page-title', 'post-3']);
  });

  it('preserves duplicate entry order and external parent references for the server conflict policy', () => {
    const child = { type: 'page', slug: 'child', parent_slug: 'parent', title: 'Child' };
    const firstParent = { type: 'page', slug: 'parent', title: 'First version' };
    const secondParent = { type: 'page', slug: 'parent', title: 'Second version' };
    const external = { type: 'page', slug: 'external-child', parent_slug: 'already-imported', title: 'External child' };
    const batches = createImportBatches({ content: [child, firstParent, secondParent, external] });
    expect(batches[0]!.content).toEqual([firstParent, child, secondParent, external]);
  });

  it('does not recurse forever or duplicate entries for cyclic parent references', () => {
    const content = [
      { type: 'page', slug: 'one', parent_slug: 'two' },
      { type: 'page', slug: 'two', parent_slug: 'one' },
    ];
    const result = createImportBatches({ content }).flatMap((batch) => batch.content!);
    expect(result).toHaveLength(2);
    expect(new Set(result)).toEqual(new Set(content));
  });
});
