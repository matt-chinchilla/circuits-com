// @vitest-environment happy-dom
/**
 * BadgeEditorOverlay — the full-viewport editor.
 *
 * `<FounderBadge>` stands in for itself, emitting the same `<fire-badge>` tag
 * with the same four attributes. The vendored element itself needs a real 2D
 * canvas context, which happy-dom does not have — and the attribute mapping is
 * already pinned by `founderBadge.test.ts`, so re-proving it here would buy a
 * flaky test and nothing else. What THIS file has to prove is that the draft
 * reaches every preview, which the stand-in shows exactly.
 *
 * No JSX — a `*.test.ts` is excluded from `tsc -b`/eslint per CLAUDE.md.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BadgeDef, SupplierBadge } from '@admin/types/admin';

vi.mock('@shared/components/FounderBadge/FounderBadge', () => ({
  default: ({ look, size }: { look: SupplierBadge; size: number }) =>
    createElement('fire-badge', {
      badge: 'true',
      size: String(size),
      scheme: look.scheme,
      intensity: String(look.intensity),
      opacity: String(look.opacity),
      sparks: look.sparks ? 'true' : 'false',
    }),
}));

const updateSupplierBadge = vi.fn();
const revokeSupplierBadge = vi.fn();
const updateMyBadge = vi.fn();

vi.mock('@admin/services/adminApi', () => ({
  adminApi: {
    updateSupplierBadge: (...a: unknown[]) => updateSupplierBadge(...a),
    revokeSupplierBadge: (...a: unknown[]) => revokeSupplierBadge(...a),
  },
}));
vi.mock('@admin/services/accountApi', () => ({
  accountApi: { updateMyBadge: (...a: unknown[]) => updateMyBadge(...a) },
}));

const { default: BadgeEditorOverlay } = await import('./BadgeEditorOverlay');
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
  { id: 'b3', key: 'trailblazer', family: 'trail', label: 'Trailblazer', available: true, sort_order: 3 },
];

let container: HTMLDivElement;
let root: Root;
let onClose: ReturnType<typeof vi.fn>;
let onSaved: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  updateSupplierBadge.mockResolvedValue({ ...ROW, scheme: 'white' });
  updateMyBadge.mockResolvedValue({ ...ROW, scheme: 'white' });
  revokeSupplierBadge.mockResolvedValue({ ok: true });
  onClose = vi.fn();
  onSaved = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function open(extra: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(
      createElement(BadgeEditorOverlay, {
        mode: 'staff',
        supplierId: 's1',
        row: ROW,
        catalogue: CATALOGUE,
        supplierName: 'Chirichella Inc.',
        onClose,
        onSaved,
        ...extra,
      } as never),
    );
  });
  return container;
}

const buttons = () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[];
const byText = (t: string) => buttons().find((b) => b.textContent?.trim() === t);
const selects = () => Array.from(container.querySelectorAll('select')) as HTMLSelectElement[];
const previews = () => Array.from(container.querySelectorAll('fire-badge'));

/** React owns the value; setting `.value` alone is invisible to it. */
function change(el: HTMLSelectElement | HTMLInputElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('BadgeEditorOverlay', () => {
  it('is a modal dialog with a name, over the design ink', async () => {
    await open();
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(container.querySelector(`#${labelledBy}`)?.textContent).toContain(
      'Founding distributor badge',
    );
    const scss = readFileSync(join(__dirname, 'BadgeEditorOverlay.module.scss'), 'utf8');
    // vitest css is off, so the rule is read from disk, never from the proxy.
    expect(scss).toMatch(/\.scrim\s*\{[^}]*position:\s*fixed/);
    expect(scss).toMatch(/\.scrim\s*\{[^}]*z-index:\s*1000/);
    expect(scss).toMatch(/\.scrim\s*\{[^}]*background:\s*#1c1f22/);
  });

  it('shows one swatch per scheme, plus the three board previews', async () => {
    await open();
    const pressed = buttons().filter((b) => b.hasAttribute('aria-pressed'));
    expect(pressed).toHaveLength(BADGE_SCHEMES.length);
    expect(pressed).toHaveLength(9);
    // the one that is on is the row's own scheme
    expect(pressed.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent).toContain(
      'orange',
    );
    // nine swatches + three boards, all the same widget
    expect(previews()).toHaveLength(12);
    expect(container.textContent).toContain('Chirichella Inc.');
    for (const tier of ['Platinum', 'Gold', 'Silver']) {
      expect(container.textContent).toContain(tier);
    }
  });

  it('repaints every board preview when the scheme select moves', async () => {
    await open();
    const schemeSelect = selects()[1];
    await act(async () => change(schemeSelect, 'white'));
    // The nine swatches each keep their OWN scheme; the boards follow the draft.
    const boards = previews().slice(9);
    expect(boards).toHaveLength(3);
    for (const b of boards) expect(b.getAttribute('scheme')).toBe('white');
    // and the swatch row still offers all nine, now with white pressed
    const pressedNow = buttons().find((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressedNow?.textContent).toContain('white');
  });

  it('sends ONLY what changed, then reports and closes', async () => {
    await open();
    expect(byText('Save')!.disabled).toBe(true);
    await act(async () => change(selects()[1], 'white'));
    expect(byText('Save')!.disabled).toBe(false);
    await act(async () => byText('Save')!.click());
    expect(updateSupplierBadge).toHaveBeenCalledWith('s1', 'founder', { scheme: 'white' });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ scheme: 'white' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('routes a customer save through the account door, and offers no staff controls', async () => {
    await open({ mode: 'account', supplierId: undefined, catalogue: [] });
    expect(byText('Revoke')).toBeUndefined();
    expect(container.textContent).not.toContain('Enabled');
    // with no catalogue door, the held artwork is the one honest option
    const appearance = selects()[0];
    expect(Array.from(appearance.options).map((o) => o.value)).toEqual(['founder_badge_1']);

    await act(async () => change(selects()[1], 'white'));
    await act(async () => byText('Save')!.click());
    expect(updateMyBadge).toHaveBeenCalledWith('founder', { scheme: 'white' });
    expect(updateSupplierBadge).not.toHaveBeenCalled();
  });

  it('offers the family only, and disables an artwork that is not released', async () => {
    await open();
    const appearance = selects()[0];
    const opts = Array.from(appearance.options);
    expect(opts.map((o) => o.value)).toEqual(['founder_badge_1', 'founder_badge_2']);
    const unreleased = opts.find((o) => o.value === 'founder_badge_2')!;
    expect(unreleased.disabled).toBe(true);
    expect(unreleased.textContent).toContain('coming soon');
  });

  it('closes on Escape and restores the page scroll it locked', async () => {
    await open();
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(document.body.style.overflow).not.toBe('hidden');
    root = createRoot(container);
  });

  it('needs a second click to revoke, and never a blocking native dialog', async () => {
    await open();
    await act(async () => byText('Revoke')!.click());
    expect(revokeSupplierBadge).not.toHaveBeenCalled();
    await act(async () => byText('Really revoke?')!.click());
    expect(revokeSupplierBadge).toHaveBeenCalledWith('s1', 'founder');
    const src = readFileSync(join(__dirname, 'BadgeEditorOverlay.tsx'), 'utf8');
    expect(src).not.toMatch(/window\s*\.\s*confirm/);
  });
});

describe('the overlay is actually mounted', () => {
  const PAGES = join(__dirname, '..', '..', 'pages', 'suppliers');

  it('is mounted by the staff supplier page, not by the panel', () => {
    const src = readFileSync(join(PAGES, 'detail', 'index.tsx'), 'utf8');
    expect(src).toContain('<BadgeEditorOverlay');
    expect(src).toContain('mode="staff"');
    expect(src).toContain('onClose={() => setEditing(null)}');
    // fixed positioning is trapped by the panel's backdrop-filter, so the
    // overlay must never move inside BadgesPanel.
    const panel = readFileSync(join(__dirname, '..', 'BadgesPanel', 'BadgesPanel.tsx'), 'utf8');
    // the grep is over the whole file, so match the IMPORT, not the name the
    // panel's own doc comment quite properly mentions
    expect(panel).not.toMatch(/import .*BadgeEditorOverlay/);
  });

  it("is mounted by the customer's My Supply page in account mode", () => {
    const src = readFileSync(join(PAGES, 'mine', 'index.tsx'), 'utf8');
    expect(src).toContain('<BadgeEditorOverlay');
    expect(src).toContain('mode="account"');
    expect(src).toContain('supplierName={supplier.name}');
  });
});
