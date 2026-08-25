/**
 * The wrong-door redirect. Five branches, all of them the kind that read
 * correctly and behave backwards, so each one is pinned to the destination it
 * must produce.
 *
 * Server-rendered to a string: the guard's whole output is a <Navigate> or its
 * children, so no DOM is needed. No JSX — this is a `*.test.ts` (excluded from
 * `tsc -b`/eslint per CLAUDE.md).
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

type Auth = {
  isAuthenticated: boolean;
  loading: boolean;
  mustChangePassword: boolean;
  user: { role: string } | null;
};

let auth: Auth;

vi.mock('react-router-dom', () => ({
  // Stand in for the real redirect so the destination is readable in the markup.
  Navigate: ({ to }: { to: string }) => createElement('span', null, `->${to}`),
  useLocation: () => ({ pathname: '/admin/parts' }),
}));
vi.mock('@admin/contexts/AuthContext', () => ({ useAuth: () => auth }));

const { default: ProtectedRoute } = await import('./ProtectedRoute');

const PAGE = 'CONSOLE';

function guard(a: Auth, area?: 'admin' | 'account') {
  auth = a;
  return renderToStaticMarkup(
    createElement(ProtectedRoute, { area, children: PAGE } as never),
  );
}

const staff: Auth = {
  isAuthenticated: true,
  loading: false,
  mustChangePassword: false,
  user: { role: 'admin' },
};
const customer: Auth = { ...staff, user: { role: 'user' } };

describe('ProtectedRoute', () => {
  it('sends a signed-out visitor to sign in', () => {
    expect(guard({ ...staff, isAuthenticated: false, user: null })).toContain('-&gt;/admin/login');
  });

  it('lets a forced reset win over the mount choice', () => {
    // Even for a customer: every console route 403s until the password changes.
    expect(guard({ ...customer, mustChangePassword: true })).toContain(
      '-&gt;/admin/change-password',
    );
  });

  it('routes a customer who reaches /admin to their own mount', () => {
    expect(guard(customer, 'admin')).toContain('-&gt;/account');
  });

  it('routes staff who reach /account back to the console', () => {
    expect(guard(staff, 'account')).toContain('-&gt;/admin');
  });

  it('renders each principal at its own mount', () => {
    expect(guard(staff, 'admin')).toContain(PAGE);
    expect(guard(customer, 'account')).toContain(PAGE);
    // The owner is staff, not a customer — the role union has three arms and
    // only one of them is a customer.
    expect(guard({ ...staff, user: { role: 'owner' } }, 'admin')).toContain(PAGE);
  });

  it('defaults to guarding the admin mount', () => {
    expect(guard(customer)).toContain('-&gt;/account');
  });
});
