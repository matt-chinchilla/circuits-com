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
 * THIRD pass on this ground, so the check is now shape-blind on purpose. The
 * previous guard matched only the JSX forms it had just fixed — `to="…"` and
 * `navigate('…')` — and its own success message ("no hardcoded /admin
 * navigation left") was wrong the day it was written: `{ href: '/admin/…' }`
 * breadcrumb items, `{ to: '/admin/…' }` action tables, and `const backHref =
 * \`/admin/…\`` variables are all nav targets the regex structurally could not
 * see, and ~21 of them shipped through it. This version flags EVERY string
 * literal that opens the /admin namespace, wherever it appears, and asks one
 * question: is it inside a consolePath()/mountPath() wrap?
 *
 * Allowed without a wrap:
 *  - the UNAUTHENTICATED auth screens, which App.tsx mounts only under /admin
 *    and which therefore have no /account twin to translate to;
 *  - bare '/admin' — a redirect or crumb to the staff home hands the principal
 *    to ProtectedRoute, which sends a customer to /account, and /account IS
 *    their dashboard. The correction, not the bug;
 *  - the three files below, each of which is absolute BY DESIGN — a new page
 *    never belongs on this list; wrap the path instead.
 */
const AUTH_SCREENS = [
  '/admin/login',
  '/admin/signup',
  '/admin/verify',
  '/admin/reset-password',
  '/admin/change-password',
];

const FILE_ALLOWLIST = new Set([
  // Axios API URLs (`/admin/expenses/`, …) — the backend admin_router's
  // namespace, not browser navigation. Renders nothing.
  'services/adminApi.ts',
  // The chrome holds the canonical NAV_LINKS/TITLE_MAP tables and translates
  // every render site through mountPath(...) itself.
  'components/AdminLayout.tsx',
  // navTo()/getRoute() address /admin absolutely because the wizard is
  // staff-only (wizard/index.tsx gates on isStaff) — verified, not assumed:
  // wizardStaffOnly.test.ts pins the gate. If that gate is ever lifted,
  // helpers.ts needs consolePath and this entry goes away.
  'wizard/helpers.ts',
]);

// A quoted literal opening the /admin namespace: quote + /admin + a namespace
// boundary (subpath, closing quote, query, hash, or a template hole). The
// boundary keeps /administrator-ish strings out.
const ADMIN_LITERAL = /["'`]\/admin(?=[/'"`?#$])/g;

// Wrapper calls whose argument span may legitimately spell /admin paths.
const WRAPPER_CALL = /\b(?:consolePath|mountPath|canonicalPath)\s*\(/g;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/**
 * [start, end) index ranges covered by a wrapper call's argument list, found
 * by balancing parentheses from each call's opening paren. Raw balance — none
 * of these arguments nest parens inside string content today, and an
 * unterminated span simply runs to end-of-file (over-allowing one file's tail
 * is recoverable; silently under-matching a wrap is a false red).
 */
function wrappedSpans(src: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of src.matchAll(WRAPPER_CALL)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let end = src.length;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) {
        end = i;
        break;
      }
    }
    spans.push([open, end]);
  }
  return spans;
}

describe('the console has no hardcoded /admin target left, in any spelling', () => {
  it('routes every /admin string literal through the mount translation', () => {
    const adminRoot = fileURLToPath(new URL('..', import.meta.url));
    const offenders: string[] = [];
    const files = tsFiles(adminRoot);
    let literalsSeen = 0;
    for (const file of files) {
      const rel = relative(adminRoot, file).split('\\').join('/');
      if (FILE_ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, 'utf8');
      const spans = wrappedSpans(src);
      for (const m of src.matchAll(ADMIN_LITERAL)) {
        literalsSeen++;
        const at = m.index ?? 0;
        // The path: /admin plus its subpath chars, stopping at the closing
        // quote, a query/hash, or a template hole.
        const path = (src.slice(at + 1).match(/^\/admin[\w\-/]*/) ?? ['/admin'])[0];
        if (path === '/admin') continue;
        if (AUTH_SCREENS.includes(path)) continue;
        if (spans.some(([s, e]) => at > s && at < e)) continue;
        const line = src.slice(0, at).split('\n').length;
        offenders.push(`${rel}:${line} → ${path}`);
      }
    }
    expect(offenders).toEqual([]);
    // Anti-vacuity: a broken glob or a broken regex would pass by scanning
    // nothing. The tree holds ~150 wrapped /admin literals across 100+ files;
    // these floors trip long before the sweep can rot into a no-op.
    expect(files.length).toBeGreaterThan(80);
    expect(literalsSeen).toBeGreaterThan(100);
  });

  it('would still see a target the old guard was blind to', () => {
    // The regression that motivated this rewrite, in miniature: a breadcrumb
    // `href:` object property. Feed the scanner a synthetic source instead of
    // trusting that the tree stays broken in the right way.
    const src = "const crumbs = [{ label: 'Leads', href: '/admin/leads' }];";
    const hits = [...src.matchAll(ADMIN_LITERAL)];
    expect(hits).toHaveLength(1);
    // And the wrapped form of the same line is what passes.
    const fixed = "const crumbs = [{ label: 'Leads', href: consolePath('/admin/leads') }];";
    const spans = wrappedSpans(fixed);
    const at = fixed.matchAll(ADMIN_LITERAL).next().value?.index ?? -1;
    expect(spans.some(([s, e]) => at > s && at < e)).toBe(true);
  });
});
