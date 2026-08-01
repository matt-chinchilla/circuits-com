import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  DEMO_READ_ONLY_DETAIL,
  DEMO_READ_ONLY_MESSAGE,
  demoReadOnlyNotice,
  demoSession,
  isDemoReadOnly,
} from '@admin/services/demoReadOnly';
import { apiErrorDetail } from '@admin/services/apiError';

/**
 * The client half of the read-only demo (task 8). The SERVER is what actually
 * refuses the write (403 `demo_account_read_only` from
 * `auth_service.get_current_user`); everything tested here is about answering
 * that refusal in plain English instead of leaking an API code at the user.
 */

beforeEach(() => {
  demoReadOnlyNotice.reset();
});

describe('isDemoReadOnly', () => {
  it('matches the exact backend detail on a 403', () => {
    expect(isDemoReadOnly(403, DEMO_READ_ONLY_DETAIL)).toBe(true);
  });

  it('ignores an ordinary permissions 403', () => {
    // The detail string is the discriminator — a bare 403 must NOT be read as
    // the demo gate, or a real authorization failure would show demo copy.
    expect(isDemoReadOnly(403, 'Not enough permissions')).toBe(false);
    expect(isDemoReadOnly(403, undefined)).toBe(false);
    expect(isDemoReadOnly(403, null)).toBe(false);
  });

  it('ignores the forced-password-change 403, which shares the status code', () => {
    expect(isDemoReadOnly(403, 'password_change_required')).toBe(false);
  });

  it('ignores the same detail on any other status', () => {
    expect(isDemoReadOnly(401, DEMO_READ_ONLY_DETAIL)).toBe(false);
    expect(isDemoReadOnly(409, DEMO_READ_ONLY_DETAIL)).toBe(false);
    expect(isDemoReadOnly(undefined, DEMO_READ_ONLY_DETAIL)).toBe(false);
  });
});

describe('demoReadOnlyNotice store', () => {
  it('starts at zero so nothing renders before a refusal', () => {
    expect(demoReadOnlyNotice.getSequence()).toBe(0);
  });

  it('increments on every raise — a counter, not a latched boolean', () => {
    // This is the whole reason it is a number: the notice auto-hides, and the
    // NEXT refused edit has to be able to show it again. A boolean already
    // `true` would emit no change and the second refusal would look ignored.
    demoReadOnlyNotice.raise();
    expect(demoReadOnlyNotice.getSequence()).toBe(1);
    demoReadOnlyNotice.raise();
    expect(demoReadOnlyNotice.getSequence()).toBe(2);
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = demoReadOnlyNotice.subscribe(listener);
    demoReadOnlyNotice.raise();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    demoReadOnlyNotice.raise();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a listener that unsubscribes mid-notification', () => {
    // raise() iterates a COPY of the set; without that, removing during the
    // loop would skip the next listener.
    const second = vi.fn();
    let unsubscribeFirst: (() => void) | undefined;
    unsubscribeFirst = demoReadOnlyNotice.subscribe(() => unsubscribeFirst?.());
    demoReadOnlyNotice.subscribe(second);
    demoReadOnlyNotice.raise();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('demoSession flag', () => {
  it('defaults to false — a real admin is never treated as demo', () => {
    expect(demoSession.isDemo()).toBe(false);
  });

  it('round-trips what AuthContext writes', () => {
    demoSession.set(true);
    expect(demoSession.isDemo()).toBe(true);
    // logout() clears it, so the next sign-in on the same tab starts clean.
    demoSession.set(false);
    expect(demoSession.isDemo()).toBe(false);
  });
});

describe('apiErrorDetail translates the machine code', () => {
  const axiosError = (detail: unknown) => ({
    isAxiosError: true,
    response: { status: 403, data: { detail } },
  });

  it('never surfaces the raw code to a form', () => {
    // Sponsor/supplier forms render apiErrorDetail(err) inline. Without the
    // mapping the user would read "demo_account_read_only".
    expect(apiErrorDetail(axiosError(DEMO_READ_ONLY_DETAIL))).toBe(DEMO_READ_ONLY_MESSAGE);
    expect(apiErrorDetail(axiosError(DEMO_READ_ONLY_DETAIL))).not.toContain('_');
  });

  it('passes human-written details through untouched', () => {
    const prose = 'This category already has an active Platinum sponsor.';
    expect(apiErrorDetail(axiosError(prose))).toBe(prose);
  });

  it('still returns undefined for a non-string detail', () => {
    // A 422 detail is an ARRAY of error objects — rendering it as a React
    // child would crash the form.
    expect(apiErrorDetail(axiosError([{ msg: 'nope' }]))).toBeUndefined();
    expect(apiErrorDetail(axiosError('   '))).toBeUndefined();
    expect(apiErrorDetail(new Error('network'))).toBeUndefined();
  });
});
