import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalPath, consoleBase, mountPath } from '@admin/services/consolePath';

/**
 * The console renders from ONE component tree at two mounts (D16). Routes
 * resolve relative to the mount on their own; the chrome does not, because
 * every sidebar link is written in its /admin form. These translate.
 *
 * They moved out of this component and into @admin/services/consolePath
 * (dozens of pages import them); the chrome contract they pin lives here.
 *
 * Without them a customer at /account gets a sidebar of /admin links and
 * every click bounces back to /account via ProtectedRoute — a console that
 * looks complete and cannot be navigated.
 */
describe('consoleBase', () => {
  it('reads /account as the customer mount', () => {
    expect(consoleBase('/account')).toBe('/account');
    expect(consoleBase('/account/parts')).toBe('/account');
    expect(consoleBase('/account/messages/abc-123')).toBe('/account');
  });

  it('reads everything else as the staff mount', () => {
    expect(consoleBase('/admin')).toBe('/admin');
    expect(consoleBase('/admin/users')).toBe('/admin');
    expect(consoleBase('/')).toBe('/admin');
  });

  it('does not mistake a lookalike prefix for the customer mount', () => {
    // /accounts-payable is not /account. A startsWith without the boundary
    // check would hand it the customer chrome.
    expect(consoleBase('/accounts-payable')).toBe('/admin');
  });
});

describe('mountPath', () => {
  it('is the identity on the staff mount', () => {
    expect(mountPath('/admin', '/admin')).toBe('/admin');
    expect(mountPath('/admin/parts', '/admin')).toBe('/admin/parts');
  });

  it('rewrites onto the customer mount', () => {
    expect(mountPath('/admin/parts', '/account')).toBe('/account/parts');
    expect(mountPath('/admin/messages/abc-123', '/account')).toBe('/account/messages/abc-123');
  });

  it('maps the dashboard root without leaving a trailing slash', () => {
    // '/account' + '' — a naive slice would yield '/account/' and miss the
    // NavLink `end` match, so the Dashboard item would never look active.
    expect(mountPath('/admin', '/account')).toBe('/account');
  });

  it('round-trips every sidebar destination', () => {
    for (const p of ['/admin', '/admin/parts', '/admin/suppliers', '/admin/users',
                     '/admin/reports', '/admin/settings']) {
      expect(mountPath(mountPath(p, '/account').replace('/account', '/admin'), '/admin')).toBe(p);
    }
  });
});

describe('the dashboard theme key follows the mount', () => {
  // The chrome remounts the dashboard's content when the theme flips so the
  // ECharts panels re-init. That key derivation compared RAW location.pathname
  // to '/admin' — false for a customer at /account, whose landing page IS the
  // dashboard, so their charts kept the old theme until a hard nav. Same
  // mistake shape as a hardcoded link, in comparison form: the sweep guard
  // cannot see comparisons, so this pin is separate. No renderer in this
  // harness — the contract is pinned half on the source, half on the function.
  const layoutSrc = readFileSync(
    fileURLToPath(new URL('./AdminLayout.tsx', import.meta.url)),
    'utf8',
  );

  it('derives the key from the canonical path, not the raw pathname', () => {
    expect(layoutSrc).toContain("canonicalPath(location.pathname) === '/admin'");
    // The raw comparisons the fix replaced must not come back.
    expect(layoutSrc).not.toContain("location.pathname === '/admin'");
    expect(layoutSrc).not.toContain("location.pathname.startsWith('/admin");
  });

  it('canonicalPath makes that comparison true on the customer dashboard', () => {
    // The half the source pin cannot carry: /account really does fold to the
    // path the key compares against.
    expect(canonicalPath('/account') === '/admin').toBe(true);
    expect(canonicalPath('/admin') === '/admin').toBe(true);
    expect(canonicalPath('/account/parts') === '/admin').toBe(false);
  });
});
