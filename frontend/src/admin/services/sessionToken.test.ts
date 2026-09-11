// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { readToken, TOKEN_KEY, tokenClaims } from './sessionToken';

function token(payload: object, base64url = false): string {
  let body = btoa(JSON.stringify(payload));
  if (base64url) body = body.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `h.${body}.s`;
}

beforeEach(() => {
  localStorage.clear();
});

describe('tokenClaims', () => {
  it('reads sub and role from the stored token', () => {
    localStorage.setItem(TOKEN_KEY, token({ sub: 'u1', role: 'viewer', exp: 5 }));
    expect(readToken()).toContain('h.');
    expect(tokenClaims()).toEqual({ sub: 'u1', role: 'viewer', exp: 5 });
  });

  it('accepts the base64url alphabet real JWTs use', () => {
    localStorage.setItem(TOKEN_KEY, token({ sub: '~~??>>', role: 'owner' }, true));
    expect(tokenClaims()?.sub).toBe('~~??>>');
  });

  it('is null without a token or with one that does not parse', () => {
    expect(tokenClaims()).toBeNull();
    localStorage.setItem(TOKEN_KEY, 'garbage');
    expect(tokenClaims()).toBeNull();
    localStorage.setItem(TOKEN_KEY, 'a.b.c');
    expect(tokenClaims()).toBeNull();
    localStorage.setItem(TOKEN_KEY, token(['not', 'an', 'object']));
    expect(tokenClaims()).toBeNull();
  });

  it('drops non-string claims instead of trusting them', () => {
    localStorage.setItem(TOKEN_KEY, token({ sub: 7, role: null }));
    expect(tokenClaims()).toEqual({ sub: undefined, role: undefined, exp: undefined });
  });
});
