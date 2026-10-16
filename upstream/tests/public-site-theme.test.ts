import { describe, expect, it } from 'vitest';
import { normalizeSiteTheme } from '../src/public-site';

describe('public-site theme selection', () => {
  it.each(['classic', 'minimal', 'editorial', 'magazine'] as const)('accepts the built-in %s theme', (theme) => {
    expect(normalizeSiteTheme(theme)).toBe(theme);
  });

  it('falls back to classic for missing or unknown themes', () => {
    expect(normalizeSiteTheme(undefined)).toBe('classic');
    expect(normalizeSiteTheme('custom-css')).toBe('classic');
  });
});
