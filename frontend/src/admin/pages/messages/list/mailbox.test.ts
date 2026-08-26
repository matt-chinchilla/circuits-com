import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MAIL_DOMAIN, staffMailboxAddress } from './mailbox';

describe('staffMailboxAddress', () => {
  it('derives a staff mailbox from the username, lower-cased', () => {
    // `Anthony` owns `anthony@` — the local-parts ARE the usernames.
    expect(staffMailboxAddress({ role: 'admin', username: 'Anthony' })).toBe(
      `anthony@${MAIL_DOMAIN}`,
    );
    expect(staffMailboxAddress({ role: 'owner', username: 'matthew' })).toBe(
      `matthew@${MAIL_DOMAIN}`,
    );
  });

  it('gives a CUSTOMER no mailbox at all', () => {
    // The defect: a customer's username IS their email address, so the inline
    // derivation this replaced produced 'buyer@acme.com@circuitcenter.ai' —
    // a malformed address pointing at staff webmail they cannot sign in to.
    expect(staffMailboxAddress({ role: 'user', username: 'buyer@acme.com' })).toBeNull();
    // Even a customer whose username happens to look like a local-part: the
    // role is the reason, not the shape.
    expect(staffMailboxAddress({ role: 'user', username: 'buyer' })).toBeNull();
  });

  it('gives no mailbox before the user is known', () => {
    expect(staffMailboxAddress(null)).toBeNull();
    expect(staffMailboxAddress(undefined)).toBeNull();
  });

  it('refuses a username that cannot be a local-part', () => {
    // Belt and braces behind the role check: printing a broken address is
    // worse than printing nothing.
    expect(staffMailboxAddress({ role: 'admin', username: 'first last' })).toBeNull();
    expect(staffMailboxAddress({ role: 'admin', username: 'staff@elsewhere.com' })).toBeNull();
    expect(staffMailboxAddress({ role: 'admin', username: '   ' })).toBeNull();
  });
});

describe('the Messages screen asks this module rather than deriving its own', () => {
  // There is no renderer in this harness, so the wiring is asserted against
  // the source. It is worth asserting: the bug was not a wrong helper, it was
  // an address built inline in the JSX, and the helper only fixes the screen
  // for as long as the screen keeps calling it.
  const page = readFileSync(
    fileURLToPath(new URL('./index.tsx', import.meta.url)),
    'utf8',
  );

  it('renders the link off staffMailboxAddress', () => {
    expect(page).toContain('staffMailboxAddress(user)');
  });

  it('never rebuilds an address from the username', () => {
    // `${user.username.toLowerCase()}@circuitcenter.ai` — the exact shape that
    // produced 'buyer@acme.com@circuitcenter.ai' on the customer mount.
    expect(page).not.toMatch(/username[^\n]*\}@/);
  });
});
