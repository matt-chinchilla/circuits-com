import { describe, it, expect } from 'vitest';
import { REAUTH_CHALLENGE, isReauthChallenge } from './reauthChallenge';

describe('isReauthChallenge', () => {
  it('recognises the account self-delete whatever case the method arrives in', () => {
    expect(isReauthChallenge('delete', '/account/me')).toBe(true);
    expect(isReauthChallenge('DELETE', '/account/me')).toBe(true);
  });

  it('spares nothing else — an expired token must still retire the session', () => {
    expect(isReauthChallenge('get', '/account/me')).toBe(false);
    expect(isReauthChallenge('delete', '/admin/users/abc')).toBe(false);
    expect(isReauthChallenge('post', '/auth/login')).toBe(false);
    expect(isReauthChallenge('delete', '/account/me/extra')).toBe(false);
  });

  it('does not spare a 401 that arrived with no request config', () => {
    // error.config is optional on an axios error; a missing one is an ordinary
    // 401 and must go down the sign-out path.
    expect(isReauthChallenge(undefined, undefined)).toBe(false);
    expect(isReauthChallenge(null, null)).toBe(false);
    expect(isReauthChallenge('delete', undefined)).toBe(false);
  });

  it('matches the request adminApi.deleteMyAccount actually sends', () => {
    // The constant is what the two halves agree on; if adminApi's call is
    // rewritten to a different url, this pair is where it shows.
    expect(isReauthChallenge(REAUTH_CHALLENGE.method, REAUTH_CHALLENGE.url)).toBe(true);
  });
});
