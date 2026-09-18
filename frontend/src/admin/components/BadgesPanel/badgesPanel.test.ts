// @vitest-environment happy-dom
/**
 * BadgesPanel — the badge holding AND its inline editor, in both consoles.
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
 *    import is an echo proxy) — an SCSS rule is read from the file instead.
 *
 * `<FounderBadge>` stands in for itself, emitting the same tag with the same
 * attributes. The vendored element needs a real 2D canvas context, which
 * happy-dom has not got — and the attribute mapping is already pinned by
 * `founderBadge.test.ts`, so re-proving it here would buy a flaky test and
 * nothing else. What THIS file has to prove is that the draft reaches every
 * preview, which the stand-in shows exactly.
 *
 * No JSX — a `*.test.ts` is excluded from `tsc -b`/eslint per CLAUDE.md.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BadgeDef, SupplierBadge } from '@admin/types/admin';

const getSupplierBadges = vi.fn();
const getBadgeCatalogue = vi.fn();
const grantSupplierBadge = vi.fn();
const updateSupplierBadge = vi.fn();
const revokeSupplierBadge = vi.fn();
const getMyBadges = vi.fn();
const updateMyBadge = vi.fn();

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
  accountApi: {
    getMyBadges: (...a: unknown[]) => getMyBadges(...a),
    updateMyBadge: (...a: unknown[]) => updateMyBadge(...a),
  },
}));
vi.mock('@shared/components/FounderBadge/FounderBadge', () => ({
  default: ({ look, size }: { look: SupplierBadge; size: number }) =>
    createElement('fire-badge', {
      'data-mark': '',
      size: String(size),
      scheme: look.scheme,
      intensity: String(look.intensity),
      opacity: String(look.opacity),
      sparks: look.sparks ? 'true' : 'false',
    }),
}));

const { default: BadgesPanel } = await import('./BadgesPanel');
const { _resetQueryCache } = await import('@admin/services/queryCache');
const { BADGE_SCHEMES } = await import('@shared/types/badge');

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

const CATALOGUE: BadgeDef[] = [
  { id: 'b1', key: 'founder_badge_1', family: 'founder', label: 'Founding distributor', available: true, sort_order: 1 },
  { id: 'b2', key: 'founder_badge_2', family: 'founder', label: 'Founding distributor II', available: false, sort_order: 2 },
  { id: 'b3', key: 'trailblazer', family: 'trail', label: 'Trailblazer', available: false, sort_order: 3 },
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
  updateSupplierBadge.mockResolvedValue({ ...ROW, scheme: 'white' });
  updateMyBadge.mockResolvedValue({ ...ROW, scheme: 'white' });
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

/** Re-mount from scratch in the other mode, inside one test. */
async function remount(props: Record<string, unknown>) {
  await act(async () => root.unmount());
  root = createRoot(container);
  _resetQueryCache();
  return mount(props);
}

const buttons = () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
const byText = (t: string) => buttons().find((b) => b.textContent?.trim() === t);
const selects = () => Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
const marks = () => Array.from(container.querySelectorAll('fire-badge'));
const optionsOf = (s: HTMLSelectElement) => Array.from(s.options);

/** React owns the value; setting `.value` alone is invisible to it. */
function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('BadgesPanel', () => {
  it('renders the holding with its mark, label and appearance key in both modes', async () => {
    await mount({ mode: 'staff', supplierId: 's1' });
    const mark = marks()[0];
    expect(mark.getAttribute('size')).toBe('32');
    expect(mark.getAttribute('scheme')).toBe('orange');
    expect(container.textContent).toContain('Founding distributor');
    expect(container.textContent).toContain('founder_badge_1');
    expect(getSupplierBadges).toHaveBeenCalledWith('s1');
  });

  it('gives staff Grant, Enabled and Revoke, and gives the customer none of them', async () => {
    await mount({ mode: 'staff', supplierId: 's1' });
    expect(container.textContent).toContain('Grant');
    expect(container.textContent).toContain('Enabled');
    expect(byText('Revoke')).toBeTruthy();

    await remount({ mode: 'account' });
    expect(getMyBadges).toHaveBeenCalled();
    expect(container.textContent).not.toContain('Grant');
    expect(container.textContent).not.toContain('Enabled');
    expect(byText('Revoke')).toBeUndefined();
  });

  it('offers only families not already held, and disables what is not available yet', async () => {
    await mount({ mode: 'staff', supplierId: 's1' });
    const grant = container.querySelector('#badge-grant') as HTMLSelectElement;
    const values = optionsOf(grant).map((o) => o.value);
    // `founder` is held, so both its catalogue entries are gone from the list.
    expect(values).not.toContain('founder_badge_1');
    expect(values).not.toContain('founder_badge_2');
    const trail = optionsOf(grant).find((o) => o.value === 'trailblazer');
    expect(trail?.disabled).toBe(true);
    expect(trail?.textContent).toContain('coming soon');
  });

  it('needs a SECOND revoke click, and never a blocking window.confirm', async () => {
    await mount({ mode: 'staff', supplierId: 's1' });
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

  it('flips Enabled through the staff patch, without touching the look draft', async () => {
    await mount({ mode: 'staff', supplierId: 's1' });
    const box = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => box.click());
    expect(updateSupplierBadge).toHaveBeenCalledWith('s1', 'founder', { enabled: false });
  });

  it('is empty-but-useful: staff keep the grant control, the customer is told to wait', async () => {
    getSupplierBadges.mockResolvedValue([]);
    getMyBadges.mockResolvedValue([]);
    await mount({ mode: 'staff', supplierId: 's1' });
    expect(container.querySelector('#badge-grant')).toBeTruthy();
    expect(container.textContent).not.toContain('once it is granted');

    await remount({ mode: 'account' });
    expect(container.textContent).toContain('Your badge will appear here once it is granted.');
    // no controls at all when there is nothing to edit
    expect(selects()).toHaveLength(0);
  });
});

// ── The editor, inline and always open ─────────────────────────────────────

describe('the inline editor', () => {
  it('is open with no Edit button, no dialog and no scrim', async () => {
    await mount({ mode: 'staff', supplierId: 's1', supplierName: 'Chirichella Inc.' });
    expect(byText('Edit')).toBeUndefined();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // the controls are simply THERE
    expect(container.textContent).toContain('Appearance');
    expect(container.textContent).toContain('Scheme');
    expect(byText('Save changes')).toBeTruthy();
    expect(byText('Discard changes')).toBeTruthy();
    // nothing left the page scrollable-locked, because nothing locks it
    expect(document.body.style.overflow).not.toBe('hidden');
  });

  it('shows one swatch per scheme on the dark bench, plus three board previews', async () => {
    await mount({ mode: 'staff', supplierId: 's1', supplierName: 'Chirichella Inc.' });
    const pressed = buttons().filter((b) => b.hasAttribute('aria-pressed'));
    expect(pressed).toHaveLength(BADGE_SCHEMES.length);
    expect(pressed).toHaveLength(9);
    expect(pressed.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent).toContain(
      'orange',
    );
    // row pin + nine swatches + three boards, all the same widget
    expect(marks()).toHaveLength(13);
    expect(container.textContent).toContain('Chirichella Inc.');
    for (const tier of ['Platinum', 'Gold', 'Silver']) {
      expect(container.textContent).toContain(tier);
    }

    // The bench is the ONE dark device, and vitest's `css` is off — so the
    // rule is read from disk, never from the class-name proxy.
    const scss = readFileSync(join(__dirname, 'BadgesPanel.module.scss'), 'utf8');
    expect(scss).toMatch(/\.bench\s*\{[^}]*background:\s*#14171a/);
  });

  it('repaints every board preview when the scheme select moves', async () => {
    await mount({ mode: 'staff', supplierId: 's1', supplierName: 'Chirichella Inc.' });
    const schemeSelect = container.querySelector('#badge-founder-scheme') as HTMLSelectElement;
    await act(async () => change(schemeSelect, 'white'));
    // The nine swatches each keep their OWN scheme; the boards follow the draft.
    const boards = marks().slice(10);
    expect(boards).toHaveLength(3);
    for (const b of boards) expect(b.getAttribute('scheme')).toBe('white');
    const pressedNow = buttons().find((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressedNow?.textContent).toContain('white');
  });

  it('sends ONLY what changed, and discards back to the saved row', async () => {
    await mount({ mode: 'staff', supplierId: 's1' });
    expect(byText('Save changes')!.disabled).toBe(true);
    expect(byText('Discard changes')!.disabled).toBe(true);

    const scheme = container.querySelector('#badge-founder-scheme') as HTMLSelectElement;
    await act(async () => change(scheme, 'white'));
    expect(byText('Save changes')!.disabled).toBe(false);
    await act(async () => byText('Discard changes')!.click());
    expect(byText('Save changes')!.disabled).toBe(true);
    expect(updateSupplierBadge).not.toHaveBeenCalled();

    await act(async () => change(scheme, 'white'));
    await act(async () => byText('Save changes')!.click());
    expect(updateSupplierBadge).toHaveBeenCalledWith('s1', 'founder', { scheme: 'white' });
  });

  it('routes a customer save through the account door, and never sends `enabled`', async () => {
    await mount({ mode: 'account' });
    const scheme = container.querySelector('#badge-founder-scheme') as HTMLSelectElement;
    await act(async () => change(scheme, 'white'));
    await act(async () => byText('Save changes')!.click());
    expect(updateMyBadge).toHaveBeenCalledWith('founder', { scheme: 'white' });
    expect(updateSupplierBadge).not.toHaveBeenCalled();
    // `enabled` is a staff switch that writes on its own; a customer body is
    // `extra="forbid"` server-side, so it must never ride in this patch.
    expect(updateMyBadge.mock.calls[0][1]).not.toHaveProperty('enabled');
  });

  it('offers the family only, and disables an artwork that is not released', async () => {
    await mount({ mode: 'staff', supplierId: 's1' });
    const appearance = container.querySelector('#badge-founder-key') as HTMLSelectElement;
    const opts = optionsOf(appearance);
    expect(opts.map((o) => o.value)).toEqual(['founder_badge_1', 'founder_badge_2']);
    const unreleased = opts.find((o) => o.value === 'founder_badge_2')!;
    expect(unreleased.disabled).toBe(true);
    expect(unreleased.textContent).toContain('coming soon');
  });

  it('gives the customer the held artwork as the one honest option, never an empty select', async () => {
    await mount({ mode: 'account' });
    expect(getBadgeCatalogue).not.toHaveBeenCalled();
    const appearance = container.querySelector('#badge-founder-key') as HTMLSelectElement;
    expect(optionsOf(appearance).map((o) => o.value)).toEqual(['founder_badge_1']);
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

  it('carries the console panel rhythm from the ONE home the parts panel reads', () => {
    const vars = readFileSync(
      join(__dirname, '..', '..', 'styles', '_variables.scss'),
      'utf8',
    );
    expect(vars).toMatch(/\$admin-panel-gap:\s*20px/);
    const panel = readFileSync(join(__dirname, 'BadgesPanel.module.scss'), 'utf8');
    expect(panel).toMatch(/\.panel\s*\{[^}]*margin-top:\s*\$admin-panel-gap/);
    const page = readFileSync(
      join(PAGES, 'detail', 'SupplierDetailPage.module.scss'),
      'utf8',
    );
    expect(page).toMatch(/\.partsPanel\s*\{[^}]*margin-top:\s*\$admin-panel-gap/);
  });

  it('has no separate editor component left to drift from this one', () => {
    expect(existsSync(join(__dirname, '..', 'BadgeEditorOverlay'))).toBe(false);
    for (const page of ['detail', 'mine']) {
      const src = readFileSync(join(PAGES, page, 'index.tsx'), 'utf8');
      expect(src).not.toMatch(/import .*BadgeEditorOverlay/);
    }
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
