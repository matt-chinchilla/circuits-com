// @vitest-environment happy-dom
/**
 * The two halves of D17's client side: what a probe of GET /api/account/me
 * MEANS, and the one-shot notice the activation email depends on.
 *
 * happy-dom because the notice genuinely touches sessionStorage — the point of
 * it is surviving a redirect, which a module variable cannot do.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activationFromProbe,
  isActivationLink,
  isNotActivated,
  NOT_ACTIVATED_DETAIL,
  rememberActivation,
  takeActivationNotice,
} from './accountActivation';

beforeEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('isNotActivated', () => {
  it('pins the detail to the string auth_service actually sends', () => {
    expect(NOT_ACTIVATED_DETAIL).toBe('account_not_activated');
  });

  it('needs BOTH the 403 and the detail', () => {
    expect(isNotActivated(403, 'account_not_activated')).toBe(true);
    expect(isNotActivated(403, 'staff_only')).toBe(false);
    expect(isNotActivated(401, 'account_not_activated')).toBe(false);
    expect(isNotActivated(undefined, undefined)).toBe(false);
  });
});

describe('activationFromProbe', () => {
  it('reads a 200 as activated', () => {
    expect(
      activationFromProbe({
        ok: true,
        body: { id: 'u1', full_name: 'Ada', email: 'ada@example.com', activated: true },
      }),
    ).toBe(true);
  });

  it('believes an explicit activated:false if the gate is ever relaxed', () => {
    expect(
      activationFromProbe({
        ok: true,
        body: { id: 'u1', full_name: 'Ada', email: 'ada@example.com', activated: false },
      }),
    ).toBe(false);
  });

  it('reads the 403 as the answer it is', () => {
    expect(
      activationFromProbe({ ok: false, status: 403, detail: NOT_ACTIVATED_DETAIL }),
    ).toBe(false);
  });

  it('FAILS OPEN on every other failure', () => {
    // Telling a perfectly good customer their account is awaiting approval
    // because a request timed out is worse than showing them a console whose
    // panels can report their own errors. The server refuses either way, so
    // nothing is protected by guessing pessimistically here.
    expect(activationFromProbe({ ok: false, status: undefined, detail: undefined })).toBe(true);
    expect(activationFromProbe({ ok: false, status: 500, detail: 'boom' })).toBe(true);
    expect(activationFromProbe({ ok: false, status: 403, detail: 'staff_only' })).toBe(true);
  });
});

describe('the activation notice', () => {
  it('recognises only the exact marker the email sends', () => {
    expect(isActivationLink('?activated=1')).toBe(true);
    expect(isActivationLink('?welcome=1&activated=1')).toBe(true);
    expect(isActivationLink('?activated=0')).toBe(false);
    expect(isActivationLink('?activated')).toBe(false);
    expect(isActivationLink('')).toBe(false);
  });

  it('survives being written and read back', () => {
    rememberActivation();
    expect(takeActivationNotice()).toBe(true);
  });

  it('is spent by the first read', () => {
    rememberActivation();
    takeActivationNotice();
    expect(takeActivationNotice()).toBe(false);
  });

  it('reads false when nothing was ever written', () => {
    expect(takeActivationNotice()).toBe(false);
  });

  it('degrades to no banner rather than throwing where storage is blocked', () => {
    // Safari private mode and locked-down browsers throw on the ACCESSOR, not
    // on the call — a congratulations banner is not worth a white screen.
    const blocked = () => {
      throw new Error('SecurityError');
    };
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(blocked as never);
    expect(() => rememberActivation()).not.toThrow();
    expect(takeActivationNotice()).toBe(false);
  });
});
