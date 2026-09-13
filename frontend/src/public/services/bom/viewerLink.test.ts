import { describe, expect, it } from 'vitest';
import { viewerRefHref } from './viewerLink';

describe('viewerRefHref', () => {
  it('appends the reference as an encoded hash', () => {
    expect(viewerRefHref('/viewer', 'R12')).toBe('/viewer#R12');
    expect(viewerRefHref('/viewer', 'U1/2')).toBe('/viewer#U1%2F2');
  });

  it('keeps a base that already carries a query', () => {
    expect(viewerRefHref('/viewer?doc=x', 'C7')).toBe('/viewer?doc=x#C7');
  });

  it('round-trips through the decode the viewer page does on mount', () => {
    const href = viewerRefHref('/viewer', 'U1/2');
    expect(decodeURIComponent(href.slice(href.indexOf('#') + 1))).toBe('U1/2');
  });
});
