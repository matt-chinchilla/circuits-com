/**
 * The three answers a sign-in can fail with. The middle one is the reason this
 * module exists: before it, an unverified registrant was told their password
 * was wrong, on the only screen that could have helped them.
 */
import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it } from 'vitest';

import { classifyLoginError, EMAIL_NOT_VERIFIED_DETAIL } from './loginError';

function httpError(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('failed', 'ERR_BAD_REQUEST', config as never, {}, {
    status,
    statusText: '',
    data,
    headers: {},
    config: config as never,
  });
}

describe('classifyLoginError', () => {
  it('names the unverified account so the screen can offer a fresh link', () => {
    expect(
      classifyLoginError(httpError(403, { detail: EMAIL_NOT_VERIFIED_DETAIL })),
    ).toBe('unverified');
  });

  it('pins the detail string to the one the server actually sends', () => {
    // If this drifts the screen goes back to lying, silently.
    expect(EMAIL_NOT_VERIFIED_DETAIL).toBe('email_not_verified');
  });

  it('leaves the generic 401 generic (anti-enumeration)', () => {
    expect(classifyLoginError(httpError(401, { detail: 'Invalid credentials' }))).toBe(
      'credentials',
    );
  });

  it('does not read a response-less error as a bad password', () => {
    const offline = new AxiosError('Network Error', 'ERR_NETWORK');
    expect(classifyLoginError(offline)).toBe('unreachable');
  });

  it('leaves the forced-reset 403 alone', () => {
    // Also a 403, and it must keep flowing to the passwordGate rather than
    // turning into a "confirm your email" prompt.
    expect(classifyLoginError(httpError(403, { detail: 'password_change_required' }))).toBe(
      'credentials',
    );
  });

  it('does not match the detail on its own', () => {
    expect(classifyLoginError(httpError(400, { detail: EMAIL_NOT_VERIFIED_DETAIL }))).toBe(
      'credentials',
    );
  });

  it('treats a non-axios throw as the generic failure', () => {
    expect(classifyLoginError(new TypeError('boom'))).toBe('credentials');
    expect(classifyLoginError(null)).toBe('credentials');
  });
});
