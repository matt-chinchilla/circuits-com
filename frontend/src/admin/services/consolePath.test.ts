import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { canonicalPath, consoleBase, mountPath, useConsolePath } from './consolePath';

describe('canonicalPath', () => {
  it('folds a customer path back to its /admin form', () => {
    expect(canonicalPath('/account')).toBe('/admin');
    expect(canonicalPath('/account/parts')).toBe('/admin/parts');
    expect(canonicalPath('/account/messages/abc-123')).toBe('/admin/messages/abc-123');
  });

  it('leaves a staff path alone', () => {
    expect(canonicalPath('/admin')).toBe('/admin');
    expect(canonicalPath('/admin/parts')).toBe('/admin/parts');
  });

  it('does not fold a lookalike prefix', () => {
    // Shares consoleBase's boundary check, so /accounts-payable is not the
    // customer mount and must survive untouched.
    expect(canonicalPath('/accounts-payable')).toBe('/accounts-payable');
  });

  it('is the exact inverse of mountPath on the customer mount', () => {
    for (const p of ['/admin', '/admin/parts', '/admin/suppliers/abc/edit', '/admin/leads/1']) {
      expect(canonicalPath(mountPath(p, '/account'))).toBe(p);
    }
  });
});

describe('useConsolePath', () => {
  it('is exported as a hook for call sites to use', () => {
    // The hook itself needs a Router, which this harness has no renderer for.
    // What is pinned here is that pages have something to import: the sweep
    // guard below is what proves they actually do.
    expect(typeof useConsolePath).toBe('function');
  });
});

/*
 * The sweep guard.
 *
 * The console renders at two mounts (D16) and an absolute /admin URL only
 * works at one of them: handed to a customer at /account it bounces straight
 * back via ProtectedRoute. The console shipped with 78 of these across 31
 * files, which is what made the customer mount unnavigable — so the rule is
 * mechanical rather than a habit, and it is checked here.
 *
 * Nav targets must go through consolePath()/mountPath(). The exceptions are
 * the UNAUTHENTICATED auth screens, which App.tsx mounts only under /admin and
 * which therefore have no /account twin to translate to.
 */
const AUTH_SCREENS = [
  '/admin/login',
  '/admin/signup',
  '/admin/verify',
  '/admin/reset-password',
  '/admin/change-password',
];

// Bare '/admin' as a REDIRECT to the staff home. Legitimate in exactly two
// places, both of which are handing a principal to the guard that will sort
// them out: a customer who lands on /admin is redirected to /account by
// ProtectedRoute, which is the correction, not the bug.
const STAFF_HOME_REDIRECTS = new Set([
  'components/ProtectedRoute.tsx',
  'pages/change-password/index.tsx',
]);

// to="/admin/…" | to={`/admin/…`} | navigate('/admin/…' | navigate(`/admin/…`
const NAV_TARGET =
  /\bto=(?:["'](\/admin[^"']*)["']|\{`(\/admin[^`]*)`\})|\bnavigate\(\s*["'`](\/admin[^"'`]*)["'`]/g;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('the console has no hardcoded /admin navigation left', () => {
  it('routes every nav target through the mount translation', () => {
    const adminRoot = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    for (const file of tsxFiles(adminRoot)) {
      const rel = relative(adminRoot, file).split('\\').join('/');
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(NAV_TARGET)) {
        const target = (m[1] ?? m[2] ?? m[3]) as string;
        const bare = target.split('?')[0];
        if (AUTH_SCREENS.includes(bare)) continue;
        if (bare === '/admin' && STAFF_HOME_REDIRECTS.has(rel)) continue;
        const line = src.slice(0, m.index ?? 0).split('\n').length;
        offenders.push(`${rel}:${line} → ${target}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
