import { describe, expect, it } from 'vitest';
import { activationControl } from './activationControl';

describe('activationControl', () => {
  it('offers Activate while the account is waiting', () => {
    expect(activationControl({ activatedAt: null, viewerIsOwner: true }).kind).toBe('activate');
    expect(activationControl({ activatedAt: null, viewerIsOwner: false }).kind).toBe('activate');
  });

  it('treats an absent key the same as null', () => {
    // `?: T` catches undefined only; Python None arrives as JSON null.
    expect(activationControl({ activatedAt: undefined, viewerIsOwner: true }).kind).toBe('activate');
  });

  it('never offers a way back once activated — the server refuses it', () => {
    for (const owner of [true, false]) {
      const c = activationControl({ activatedAt: '2026-08-26T00:00:00Z', viewerIsOwner: owner });
      expect(c.kind).not.toBe('activate');
    }
  });

  it('gives the owner Delete once the account is live', () => {
    expect(
      activationControl({ activatedAt: '2026-08-26T00:00:00Z', viewerIsOwner: true }).kind,
    ).toBe('delete');
  });

  it('gives a non-owner admin nothing to press', () => {
    // DELETE is require_owner, so a Delete button here would always 403.
    expect(
      activationControl({ activatedAt: '2026-08-26T00:00:00Z', viewerIsOwner: false }).kind,
    ).toBe('activated-readonly');
  });
});
