export interface ImportContentItem {
  type?: string;
  slug?: string;
  parent_slug?: string;
  [key: string]: unknown;
}

export interface ImportPackage {
  format?: string;
  version?: string;
  source?: Record<string, unknown> | null;
  categories?: unknown[];
  tags?: unknown[];
  content?: ImportContentItem[];
  moments?: unknown[];
}

export function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function prepareContent(content: ImportContentItem[]): ImportContentItem[] {
  return content.map((item, index) => {
    const type = trimmed(item.type) === 'page' ? 'page' : 'post';
    const value = trimmed(item.slug) || trimmed(item.title);
    // Match the import API normalization before sorting/splitting so title-derived
    // slugs and positional fallbacks keep the same identity in every batch.
    const slug = value.toLowerCase().replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') || `${type}-${index + 1}`;
    return { ...item, slug };
  });
}

function orderPagesBeforeChildren(content: ImportContentItem[]): ImportContentItem[] {
  const pages = new Map<string, number>();
  content.forEach((item, index) => {
    if (trimmed(item.type) === 'page' && trimmed(item.slug)) {
      // Keep the first occurrence so duplicate/skip/update conflicts retain their order.
      if (!pages.has(trimmed(item.slug))) pages.set(trimmed(item.slug), index);
    }
  });

  const ordered: ImportContentItem[] = [];
  const state = new Map<number, 'visiting' | 'done'>();
  function visit(index: number) {
    if (state.has(index)) return;
    state.set(index, 'visiting');
    const item = content[index]!;
    const parent = trimmed(item.type) === 'page' && trimmed(item.parent_slug)
      ? pages.get(trimmed(item.parent_slug))
      : undefined;
    if (parent !== undefined) visit(parent);
    state.set(index, 'done');
    ordered.push(item);
  }
  content.forEach((_, index) => visit(index));
  return ordered;
}

export function createImportBatches(pkg: ImportPackage, batchSize = 20): ImportPackage[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('Invalid import batch size.');
  const batches: ImportPackage[] = [];
  const base = { format: pkg.format || 'cfblog-import', version: pkg.version || '1.1', source: pkg.source || null };
  const content = orderPagesBeforeChildren(prepareContent(toArray(pkg.content) as ImportContentItem[]));
  const moments = toArray(pkg.moments);
  for (let start = 0; start < content.length; start += batchSize) {
    batches.push({
      ...base,
      categories: batches.length ? [] : toArray(pkg.categories),
      tags: batches.length ? [] : toArray(pkg.tags),
      content: content.slice(start, start + batchSize),
      moments: [],
    });
  }
  for (let start = 0; start < moments.length; start += batchSize) {
    batches.push({ ...base, categories: [], tags: [], content: [], moments: moments.slice(start, start + batchSize) });
  }
  return batches;
}
