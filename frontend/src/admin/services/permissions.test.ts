import { describe, it, expect } from 'vitest';
import { OWNER_ONLY_DETAIL, canDeleteMessages, isOwner } from './permissions';

describe('canDeleteMessages', () => {
  it('grants the owner', () => {
    expect(canDeleteMessages({ role: 'owner' })).toBe(true);
  });

  it('refuses every other role', () => {
    expect(canDeleteMessages({ role: 'admin' })).toBe(false);
    expect(canDeleteMessages({ role: 'company' })).toBe(false);
  });

  it('refuses an unknown user rather than defaulting open', () => {
    // Null is the state while /auth/me is still in flight AND the state after
    // sign-out — withholding the control is the only safe reading of "unknown".
    expect(canDeleteMessages(null)).toBe(false);
    expect(canDeleteMessages(undefined)).toBe(false);
  });

  it('is exactly isOwner — one rule, not two that can drift', () => {
    for (const user of [{ role: 'owner' } as const, { role: 'admin' } as const, null]) {
      expect(canDeleteMessages(user)).toBe(isOwner(user));
    }
  });
});

describe('OWNER_ONLY_DETAIL', () => {
  it('matches the backend string verbatim', () => {
    // auth_service.OWNER_ONLY_DETAIL — a typo here would silently stop the
    // client recognising the gate.
    expect(OWNER_ONLY_DETAIL).toBe('owner_only');
  });
});
