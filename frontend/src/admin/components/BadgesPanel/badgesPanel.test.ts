// @vitest-environment happy-dom
/**
 * BadgesPanel — the badge holding on a supplier's page, in both consoles.
 *
 * Two kinds of test, for two kinds of claim:
 *
 *  - DOM, with both api modules stubbed: the mode split is the whole point of
 *    the component, so "staff gets Grant/Enabled/Revoke and the customer gets
 *    none of them" is rendered, not read. A customer who could see a Revoke
 *    button would be a real bug even though the server would refuse the call.
 *  - SOURCE, read off disk: that each page actually MOUNTS the panel, and in
 *    the right place. Nothing else proves the wiring, and a CSS-module class
 *    assertion proves nothing at all here (vitest's `css` is off, so the
 *    import is an echo proxy).
 *
 * No JSX — a `*.test.ts` is excluded from `tsc -b`/eslint per CLAUDE.md.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupplierBadge } from '@admin/types/admin';

const getSupplierBadges = vi.fn();
const getBadgeCatalogue = vi.fn();
const grantSupplierBadge = vi.fn();
const updateSupplierBadge = vi.fn();
const revokeSupplierBadge = vi.fn();
const getMyBadges = vi.fn();

vi.mock('@admin/services/adminApi', () => ({
  adminApi: {
    getSupplierBadges: (...a: unknown[]) => getSupplierBadges(...a),
    getBadgeCatalogue: (...a: unknown[]) => getBadgeCatalogue(...a),
    grantSupplierBadge: (...a: unknown[]) => grantSupplierBadge(...a),
    updateSupplierBadge: (...a: unknown[]) => updateSupplierBadge(...a),
    revokeSupplierBadge: (...a: unknown[]) => revokeSupplierBadge(...a),
  },
}));
vi.mock('@admin/services/accountApi', () => ({
  accountApi: { getMyBadges: (...a: unknown[]) => getMyBadges(...a) },
}));
// The mark itself is the shared widget's business (founderBadge.test.ts pins
// it). Here it stands in for itself so the LOOK reaching it is still readable.
vi.mock('@shared/components/FounderBadge/FounderBadge', () => ({
  default: ({ look, size }: { look: SupplierBadge; size: number }) =>
    createElement('span', {
      'data-mark': '',
      'data-scheme': look.scheme,
      'data-size': String(size),
    }),
}));

const { default: BadgesPanel } = await import('./BadgesPanel');
const { _resetQueryCache } = await import('@admin/services/queryCache');

const ROW: SupplierBadge = {
  id: 'r1',
  supplier_id: 's1',
  key: 'founder_badge_1',
  family: 'founder',
  label: 'Founding distributor',
  scheme: 'orange',
  intensity: 1,
  opacity: 0.75,
  sparks: true,
  available: true,
  enabled: true,
  granted_at: null,
  updated_at: null,
};

const CATALOGUE = [
  { id: 'b1', key: 'founder_badge_1', family: 'founder', label: 'Founding distributor', available: true, sort_order: 1 },
  { id: 'b2', key: 'trailblazer', family: 'trail', label: 'Trailblazer', available: false, sort_order: 2 },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  _resetQueryCache();
  vi.clearAllMocks();
  getSupplierBadges.mockResolvedValue([ROW]);
  getMyBadges.mockResolvedValue([ROW]);
  getBadgeCatalogue.mockResolvedValue(CATALOGUE);
  grantSupplierBadge.mockResolvedValue(ROW);
  updateSupplierBadge.mockResolvedValue(ROW);
  revokeSupplierBadge.mockResolvedValue({ ok: true });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mount(props: Record<string, unknown>) {
  await act(async () => {
    root.render(createElement(BadgesPanel, props as never));
  });
  // one more turn for the cached-query effect to settle
  await act(async () => {});
  return container;
}

const buttons = () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
const byText = (t: string) => buttons().find((b) => b.textContent?.trim() === t);

describe('BadgesPanel', () => {
  it('renders the holding with its mark, label and appearance key in both modes', async () => {
    await mount({ mode: 'staff', supplierId: 's1', onEdit: () => undefined });
    const mark = container.querySelector('[data-mark]');
    expect(mark?.getAttribute('data-size')).toBe('32');
    expect(mark?.getAttribute('data-scheme')).toBe('orange');
    expect(container.textContent).toContain('Founding distributor');
    expect(container.textContent).toContain('founder_badge_1');
    expect(getSupplierBadges).toHaveBeenCalledWith('s1');
  });

  it('gives staff Grant, Enabled and Revoke, and gives the customer none of them', async () => {
    await mount({ mode: 'staff', supplierId: 's1', onEdit: () => undefined });
    expect(container.textContent).toContain('Grant');
    expect(container.textContent).toContain('Enabled');
    expect(byText('Revoke')).toBeTruthy();

    await act(async () => root.unmount());
    root = createRoot(container);
    _resetQueryCache();
    await mount({ mode: 'account', onEdit: () => undefined });
    expect(getMyBadges).toHaveBeenCalled();
    expect(container.textContent).not.toContain('Grant');
    expect(container.textContent).not.toContain('Enabled');
    expect(byText('Revoke')).toBeUndefined();
    // Edit is the customer's one control.
    expect(byText('Edit')).toBeTruthy();
  });

  it('offers only families not already held, and disables what is not available yet', async () => {
    await mount({ mode: 'staff', supplierId: 's1', onEdit: () => undefined });
    const options = Array.from(
      container.querySelectorAll('select option'),
    ) as HTMLOptionElement[];
    const values = options.map((o) => o.value);
    // `founder` is held, so its catalogue entry is gone from the list.
    expect(values).not.toContain('founder_badge_1');
    const trail = options.find((o) => o.value === 'trailblazer');
    expect(trail?.disabled).toBe(true);
    expect(trail?.textContent).toContain('coming soon');
  });

  it('raises the row to the page rather than editing it here', async () => {
    const onEdit = vi.fn();
    await mount({ mode: 'account', onEdit });
    await act(async () => byText('Edit')!.click());
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'r1' }));
  });

  it('needs a SECOND revoke click, and never a blocking window.confirm', async () => {
    await mount({ mode: 'staff', supplierId: 's1', onEdit: () => undefined });
    await act(async () => byText('Revoke')!.click());
    expect(revokeSupplierBadge).not.toHaveBeenCalled();
    expect(byText('Really revoke?')).toBeTruthy();
    await act(async () => byText('Really revoke?')!.click());
    expect(revokeSupplierBadge).toHaveBeenCalledWith('s1', 'founder');

    // The grep is over the whole FILE, comments included — so the source
    // describes the native dialog rather than spelling its call.
    const src = readFileSync(join(__dirname, 'BadgesPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/window\s*\.\s*confirm/);
  });

  it('flips Enabled through the staff patch', async () => {
    await mount({ mode: 'staff', supplierId: 's1', onEdit: () => undefined });
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => box.click());
    expect(updateSupplierBadge).toHaveBeenCalledWith('s1', 'founder', { enabled: false });
  });

  it('is empty-but-useful: staff keep the grant control, the customer is told to wait', async () => {
    getSupplierBadges.mockResolvedValue([]);
    getMyBadges.mockResolvedValue([]);
    await mount({ mode: 'staff', supplierId: 's1', onEdit: () => undefined });
    expect(container.querySelector('select')).toBeTruthy();
    expect(container.textContent).not.toContain('once it is granted');

    await act(async () => root.unmount());
    root = createRoot(container);
    _resetQueryCache();
    await mount({ mode: 'account', onEdit: () => undefined });
    expect(container.textContent).toContain('Your badge will appear here once it is granted.');
    expect(container.querySelector('select')).toBeNull();
  });
});

// ── Source-level witnesses ────────────────────────────────────────────────

const PAGES = join(__dirname, '..', '..', 'pages', 'suppliers');

describe('the panel is actually mounted', () => {
  it('sits above Listed Parts on the staff supplier page', () => {
    const src = readFileSync(join(PAGES, 'detail', 'index.tsx'), 'utf8');
    const panel = src.indexOf('<BadgesPanel mode="staff"');
    const parts = src.indexOf('styles.partsPanel');
    expect(panel, 'staff detail must mount BadgesPanel').toBeGreaterThan(-1);
    expect(panel).toBeLessThan(parts);
    expect(src).toContain('supplierId={id}');
  });

  it("sits under the company card in the customer's My Supply, inside the ready branch", () => {
    const src = readFileSync(join(PAGES, 'mine', 'index.tsx'), 'utf8');
    const ready = src.indexOf("status === 'ready'");
    const card = src.indexOf('<MyCompanyCard');
    const panel = src.indexOf('<BadgesPanel mode="account"');
    expect(panel).toBeGreaterThan(card);
    expect(card).toBeGreaterThan(ready);
  });

  it("declares the reads' data scope, and the client union still names it", () => {
    const cache = readFileSync(join(__dirname, '..', '..', 'services', 'queryCache.ts'), 'utf8');
    // test_data_versions.py holds this union to the server's SCOPES; the panel
    // is the reason `badges` is in it at all.
    expect(cache).toMatch(/\|\s*'badges'/);
    const src = readFileSync(join(__dirname, 'BadgesPanel.tsx'), 'utf8');
    expect(src).toContain("scopes: BADGE_SCOPES");
  });
});
