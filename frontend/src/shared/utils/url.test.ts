import { describe, expect, it } from 'vitest';
import { prependScheme, safeHttpUrl, safeImageUrl } from './url';

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

  it('resolves protocol-relative URLs to https', () => {
    expect(safeHttpUrl('//acme.com')).toBe('https://acme.com/');
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

describe('safeImageUrl', () => {
  it('allows http and https URLs', () => {
    expect(safeImageUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(safeImageUrl('http://example.com/a.jpg')).toBe('http://example.com/a.jpg');
  });
  it('allows raster data-image URLs', () => {
    const d = 'data:image/webp;base64,AAAA';
    expect(safeImageUrl(d)).toBe(d);
    expect(safeImageUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeImageUrl('data:image/jpeg;base64,AAAA')).toBe('data:image/jpeg;base64,AAAA');
  });
  it('rejects script and html data URLs', () => {
    expect(safeImageUrl('javascript:alert(1)')).toBeNull();
    expect(safeImageUrl('data:text/html;base64,AAAA')).toBeNull();
    expect(safeImageUrl('data:image/svg+xml;base64,AAAA')).toBeNull();
  });
  it('returns null for empty/garbage', () => {
    expect(safeImageUrl('')).toBeNull();
    expect(safeImageUrl(null)).toBeNull();
    expect(safeImageUrl('not a url')).toBeNull();
  });
});
