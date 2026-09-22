import { describe, expect, it } from 'vitest';
import { isNotFoundError } from './notFound';
import { NOT_FOUND_SEO, STATIC_PAGE_SEO } from './seoRoutes';

describe('isNotFoundError — only a definitive 404 earns noindex', () => {
  it('is true for an HTTP 404', () => {
    expect(isNotFoundError({ response: { status: 404 } })).toBe(true);
  });

  it('is false for a transient failure, which must never de-index a real page', () => {
    expect(isNotFoundError({ response: { status: 502 } })).toBe(false);
    expect(isNotFoundError({ response: { status: 500 } })).toBe(false);
    expect(isNotFoundError({ response: { status: 422 } })).toBe(false);
    // A network error: axios rejects with no response at all.
    expect(isNotFoundError({ message: 'Network Error' })).toBe(false);
    expect(isNotFoundError(new Error('boom'))).toBe(false);
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
    expect(isNotFoundError({ response: null })).toBe(false);
  });
});

describe('NOT_FOUND_SEO', () => {
  it('keeps the not-found state out of the index and claims no canonical', () => {
    expect(NOT_FOUND_SEO.robots).toBe('noindex');
    expect(NOT_FOUND_SEO.canonical).toBeNull();
    expect(NOT_FOUND_SEO.jsonLd).toEqual([]);
  });

  it('is not a prerendered route', () => {
    // A prerendered document carrying noindex could be served for a real URL.
    expect(Object.values(STATIC_PAGE_SEO)).not.toContain(NOT_FOUND_SEO);
  });
});
