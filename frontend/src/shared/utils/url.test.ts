import { describe, expect, it } from 'vitest';
import { prependScheme, safeHttpUrl } from './url';

describe('prependScheme', () => {
  it('prepends https:// to a bare hostname', () => {
    expect(prependScheme('acme.com')).toBe('https://acme.com');
  });

  it('leaves an already-schemed URL untouched', () => {
    expect(prependScheme('http://acme.com')).toBe('http://acme.com');
    expect(prependScheme('mailto:a@b.com')).toBe('mailto:a@b.com');
  });

  it('leaves a protocol-relative URL untouched', () => {
    expect(prependScheme('//acme.com')).toBe('//acme.com');
  });

  it('returns empty string for blank input', () => {
    expect(prependScheme('   ')).toBe('');
  });
});

describe('safeHttpUrl', () => {
  it('accepts a bare hostname and returns a normalized https href', () => {
    expect(safeHttpUrl('kennedyelectronics.com')).toBe('https://kennedyelectronics.com/');
  });

  it('accepts explicit http and https schemes', () => {
    expect(safeHttpUrl('http://acme.com')).toBe('http://acme.com/');
    expect(safeHttpUrl('https://acme.com/path?q=1')).toBe('https://acme.com/path?q=1');
  });

  it('trims surrounding whitespace', () => {
    expect(safeHttpUrl('  acme.com  ')).toBe('https://acme.com/');
  });

  // The whole point: dangerous schemes must NEVER survive into an href.
  it('rejects javascript: URLs (XSS)', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('JavaScript:alert(document.cookie)')).toBeNull();
  });

  it('rejects data:, vbscript:, and file: schemes', () => {
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeHttpUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects non-web schemes like mailto: and tel:', () => {
    expect(safeHttpUrl('mailto:a@b.com')).toBeNull();
    expect(safeHttpUrl('tel:+18005551234')).toBeNull();
  });

  it('returns null for empty, null, or undefined input', () => {
    expect(safeHttpUrl('')).toBeNull();
    expect(safeHttpUrl('   ')).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
  });
});
