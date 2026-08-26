/**
 * Console mount addressing.
 *
 * The console renders from ONE component tree at TWO mounts (D16) — /admin for
 * staff, /account for customers. React Router resolves each page's own routes
 * relative to whichever mount matched, so the ROUTES come out right on their
 * own. Nothing else does: every sidebar entry, every <Link>, and every
 * navigate() in the console is written in its canonical /admin form, and an
 * absolute /admin URL handed to a customer is a dead end — ProtectedRoute
 * bounces them straight back to /account, so the console looks complete and
 * cannot be navigated.
 *
 * These three functions are the translation, and `useConsolePath` is how a page
 * reaches them: keep writing /admin paths, wrap them at the call site.
 *
 *     const consolePath = useConsolePath();
 *     <Link to={consolePath('/admin/parts')}>Parts</Link>
 *
 * This lives in its own module rather than in AdminLayout because dozens of
 * pages import it, and a page importing the chrome component to get at a string
 * helper is a dependency nobody meant to create.
 *
 * NOT every /admin path belongs here. The unauthenticated auth screens —
 * /admin/login, /admin/signup, /admin/verify, /admin/reset-password,
 * /admin/change-password — are mounted ONLY under /admin (App.tsx) and have no
 * /account twin, so they stay absolute wherever they are linked.
 */
import { useCallback } from 'react';
import { useLocation } from 'react-router-dom';

export type ConsoleBase = '/admin' | '/account';

/** Which mount is rendering this pathname. */
export function consoleBase(pathname: string): ConsoleBase {
  // The boundary check is load-bearing: a bare startsWith('/account') would
  // read /accounts-payable as the customer mount.
  return pathname === '/account' || pathname.startsWith('/account/') ? '/account' : '/admin';
}

/** An /admin-form path, rewritten onto the mount currently being rendered. */
export function mountPath(adminPath: string, base: ConsoleBase): string {
  if (base === '/admin') return adminPath;
  // '/account' + '' — a naive slice would yield '/account/', which misses the
  // NavLink `end` match, so the Dashboard entry would never look active.
  return adminPath === '/admin' ? '/account' : `/account${adminPath.slice('/admin'.length)}`;
}

/** The inverse: any mount's path, in the canonical /admin form for lookups. */
export function canonicalPath(pathname: string): string {
  if (consoleBase(pathname) === '/admin') return pathname;
  const rest = pathname.slice('/account'.length);
  return rest ? `/admin${rest}` : '/admin';
}

/**
 * Rewrites a canonical /admin path onto the mount this render is under.
 *
 * Identity on the staff mount, so a page that uses it reads and behaves exactly
 * as it did at /admin — the customer mount is the only thing that changes.
 */
export function useConsolePath(): (adminPath: string) => string {
  const { pathname } = useLocation();
  const base = consoleBase(pathname);
  return useCallback((adminPath: string) => mountPath(adminPath, base), [base]);
}
