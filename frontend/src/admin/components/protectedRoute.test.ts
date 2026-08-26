// @vitest-environment happy-dom
/**
 * The console's front door. Eight branches now, all of them the kind that read
 * correctly and behave backwards, so each one is pinned to what it must
 * produce:
 *
 *  - the four wrong-door redirects (unchanged),
 *  - D17's client half — a verified but UNACTIVATED customer must meet the
 *    awaiting-approval screen, never the console, which would render in full
 *    and then 403 one panel at a time,
 *  - and the activation email's `?activated=1`, which cannot survive the trip
 *    to the console on its own and is stashed here, where it still exists.
 *
 * A real client root rather than renderToStaticMarkup: both new branches depend
 * on effects and on lazy children, and the server renderer runs neither.
 *
 * No JSX — a `*.test.ts` is excluded from `tsc -b`/eslint per CLAUDE.md.
 */
import { Suspense, createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Auth = {
  isAuthenticated: boolean;
  loading: boolean;
  mustChangePassword: boolean;
  accountActivated: boolean | null;
  user: { role: string } | null;
};

let auth: Auth;
let search = '';

vi.mock('react-router-dom', () => ({
  // Stand in for the real redirect so the destination is readable in the markup.
  Navigate: ({ to }: { to: string }) => createElement('span', null, `->${to}`),
  useLocation: () => ({ pathname: '/admin/parts', search }),
}));
vi.mock('@admin/contexts/AuthContext', () => ({ useAuth: () => auth }));
// The two lazy children, stubbed: AwaitingApproval drags in the whole auth
// shell (SCSS module + CSS-3D board) and neither is what this file is testing.
vi.mock('./AwaitingApproval', () => ({
  default: () => createElement('span', null, 'AWAITING'),
}));
vi.mock('./ActivationBanner', () => ({
  default: () => createElement('span', null, 'YOU-ARE-IN'),
}));

const { default: ProtectedRoute } = await import('./ProtectedRoute');

const PAGE = 'CONSOLE';

let container: HTMLDivElement;
let root: Root;

/** Mount the guard and return the markup it settled on. */
async function guard(a: Auth, area?: 'admin' | 'account') {
  auth = a;
  await act(async () => {
    root.render(
      createElement(
        Suspense,
        { fallback: 'SUSPENDED' },
        createElement(ProtectedRoute, { area, children: PAGE } as never),
      ),
    );
  });
  return container.textContent ?? '';
}

const staff: Auth = {
  isAuthenticated: true,
  loading: false,
  mustChangePassword: false,
  accountActivated: null, // never asked of staff — activated_at is NULL on those rows
  user: { role: 'admin' },
};
const customer: Auth = { ...staff, accountActivated: true, user: { role: 'user' } };

beforeEach(() => {
  search = '';
  window.sessionStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('ProtectedRoute', () => {
  it('sends a signed-out visitor to sign in', async () => {
    expect(await guard({ ...staff, isAuthenticated: false, user: null })).toContain(
      '->/admin/login',
    );
  });

  it('lets a forced reset win over the mount choice', async () => {
    // Even for a customer: every console route 403s until the password changes.
    expect(await guard({ ...customer, mustChangePassword: true })).toContain(
      '->/admin/change-password',
    );
  });

  it('routes a customer who reaches /admin to their own mount', async () => {
    expect(await guard(customer, 'admin')).toContain('->/account');
  });

  it('routes staff who reach /account back to the console', async () => {
    expect(await guard(staff, 'account')).toContain('->/admin');
  });

  it('renders each principal at its own mount', async () => {
    expect(await guard(staff, 'admin')).toContain(PAGE);
    expect(await guard(customer, 'account')).toContain(PAGE);
    // The owner is staff, not a customer — the role union has three arms and
    // only one of them is a customer.
    expect(await guard({ ...staff, user: { role: 'owner' } }, 'admin')).toContain(PAGE);
  });

  it('defaults to guarding the admin mount', async () => {
    expect(await guard(customer)).toContain('->/account');
  });

  describe('D17 — activation', () => {
    it('shows an unactivated customer the awaiting screen, not the console', async () => {
      const markup = await guard({ ...customer, accountActivated: false }, 'account');
      expect(markup).toContain('AWAITING');
      // The defect: the full console rendered and every panel 403'd at them.
      expect(markup).not.toContain(PAGE);
    });

    it('holds rather than guessing while the verdict is still in flight', async () => {
      const markup = await guard({ ...customer, accountActivated: null }, 'account');
      // Neither: rendering the console optimistically IS the bug, and rendering
      // "awaiting approval" optimistically accuses a customer who is fine.
      expect(markup).not.toContain(PAGE);
      expect(markup).not.toContain('AWAITING');
    });

    it('sends an unactivated customer to their own mount before parking them', async () => {
      // The screen must be met at /account, the URL they will bookmark — not at
      // whatever staff-side path they happened to type.
      expect(await guard({ ...customer, accountActivated: false }, 'admin')).toContain(
        '->/account',
      );
    });

    it('never gates staff on activation', async () => {
      // activated_at is NULL on every staff row; asking would park all of them.
      expect(await guard({ ...staff, accountActivated: null }, 'admin')).toContain(PAGE);
      expect(await guard({ ...staff, accountActivated: false }, 'admin')).toContain(PAGE);
    });
  });

  describe('the activation email banner', () => {
    it('shows "You’re in" when the console opens after the emailed link', async () => {
      search = '?activated=1';
      expect(await guard(customer, 'account')).toContain('YOU-ARE-IN');
    });

    it('keeps the flag across the sign-in redirect that eats the query', async () => {
      // The real trip: the link lands signed OUT, gets bounced to /admin/login
      // (which drops the query), and the console is reached afterwards with a
      // bare URL. The notice has to survive that or the email is lying.
      search = '?activated=1';
      expect(await guard({ ...customer, isAuthenticated: false, user: null })).toContain(
        '->/admin/login',
      );
      search = '';
      expect(await guard(customer, 'account')).toContain('YOU-ARE-IN');
    });

    it('is not spent by the /admin hop that bounces to /account', async () => {
      // The real sign-in trip lands on /admin first (LoginPage sends everyone
      // there) and a DIFFERENT ProtectedRoute element redirects to /account.
      // That doomed mount must not swallow the one-shot on its way out.
      search = '?activated=1';
      expect(await guard(customer, 'admin')).toContain('->/account');
      search = '';
      await act(async () => root.unmount());
      root = createRoot(container);
      expect(await guard(customer, 'account')).toContain('YOU-ARE-IN');
    });

    it('is not spent by the awaiting-approval screen either', async () => {
      // Nothing renders it there, and an unactivated customer will reach the
      // console eventually — with the greeting still owed to them.
      search = '?activated=1';
      await guard({ ...customer, accountActivated: false }, 'account');
      expect(window.sessionStorage.getItem('cc.account.activated')).toBe('1');
    });

    it('is not spent while the visitor is still signed out', async () => {
      search = '?activated=1';
      await guard({ ...customer, isAuthenticated: false, user: null });
      // Nothing rendered it, so it must still be there to render.
      expect(window.sessionStorage.getItem('cc.account.activated')).toBe('1');
    });

    it('is a one-shot — it does not greet them on every page after', async () => {
      search = '?activated=1';
      expect(await guard(customer, 'account')).toContain('YOU-ARE-IN');
      search = '';
      await act(async () => root.unmount());
      root = createRoot(container);
      expect(await guard(customer, 'account')).not.toContain('YOU-ARE-IN');
    });

    it('does not greet an ordinary sign-in', async () => {
      expect(await guard(customer, 'account')).not.toContain('YOU-ARE-IN');
    });
  });
});
