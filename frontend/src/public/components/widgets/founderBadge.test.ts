// @vitest-environment happy-dom
/**
 * FounderBadge — the founding-distributor pin beside a sponsor's company name.
 *
 * The widget is now a thin HOST for the owner's vendored `<fire-badge>` custom
 * element, so these tests pin the seam, not the artwork: which element, which
 * attributes, which accessible name, and that the vendored file is still
 * byte-for-byte the design export (its sha256 is recorded in
 * `fireBadge/PROVENANCE.md` — the design-import folder itself is gitignored, so
 * the hash, not a `cmp`, is what a clean checkout can check).
 *
 * DOM tests use createRoot + act with no testing-library (the shape
 * bomPage.test.ts uses). The source-level tests read the three board files —
 * the badge is a shared unit precisely because it has three consumers, and
 * nothing else proves a site kept its `founder &&` guard. A CSS-module class
 * assertion proves nothing here (vitest's `css` is off, the import is an echo
 * proxy), so every rule is read from disk.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The vendor module runs at import time and reads `matchMedia` immediately, so
// the stubs have to beat the imports — hence vi.hoisted. Reduced-motion is
// stubbed ON deliberately: the element then paints one static frame and never
// starts its rAF loop, so no animation outlives the test. happy-dom has no
// ResizeObserver/IntersectionObserver and no canvas raster at all.
vi.hoisted(() => {
  const noop = () => undefined;
  class Observer {
    observe = noop;
    unobserve = noop;
    disconnect = noop;
    takeRecords = () => [];
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.matchMedia = () => ({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
  });
  g.ResizeObserver = Observer;
  g.IntersectionObserver = Observer;
  // Any 2-D call is a no-op; only createRadialGradient has to hand back an object.
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => (key === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
      set: () => true,
    },
  );
  (g.HTMLCanvasElement as { prototype: { getContext: unknown } }).prototype.getContext = () => ctx;
});

const FounderBadgeModule = await import('./FounderBadge');
const FounderBadge = FounderBadgeModule.default;
const { FOUNDER_BADGE_LABEL } = FounderBadgeModule;

const COMPONENTS = join(__dirname, '..', '..', 'pages', 'category', 'components');
const read = (file: string) => readFileSync(join(COMPONENTS, file), 'utf8');

describe('FounderBadge (DOM)', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = (size?: number) => {
    act(() => root.render(createElement(FounderBadge, size == null ? null : { size })));
    return host.firstElementChild!;
  };

  it('renders the vendored <fire-badge>, self-drawing, at the size asked for', () => {
    const el = render(22);
    expect(el.tagName.toLowerCase()).toBe('fire-badge');
    expect(el.getAttribute('badge')).toBe('true');
    expect(el.getAttribute('size')).toBe('22');
    // the artwork is the element's job, not this component's
    expect(el.querySelector('svg')).toBeNull();
    expect(host.querySelector('a')).toBeNull();
  });

  it('is an accessible image with the founding-distributor label and a hover title', () => {
    const el = render(22);
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe(FOUNDER_BADGE_LABEL);
    expect(el.getAttribute('title')).toBe(FOUNDER_BADGE_LABEL);
    expect(FOUNDER_BADGE_LABEL).toBe('Founding distributor');
  });

  it('defaults to the Gold size', () => {
    expect(render().getAttribute('size')).toBe('18');
  });

  it('carries the module class that seats it beside the name, plus any caller class', () => {
    // vitest css is off, so the module import is a proxy and the class name is
    // whatever it echoes — this proves the WIRING only; the rule is read from
    // disk further down.
    expect(render(15).className).toMatch(/badge/);
    act(() => root.render(createElement(FounderBadge, { size: 15, className: 'extra' })));
    const cls = host.firstElementChild!.className.split(/\s+/);
    expect(cls).toHaveLength(2);
    expect(cls).toContain('extra');
  });

  it('leaves the fire scheme, intensity, opacity and sparks to the element itself', () => {
    const el = render(18);
    for (const attr of ['scheme', 'intensity', 'opacity', 'sparks']) {
      expect(el.hasAttribute(attr)).toBe(false);
    }
  });

  it('upgrades: the element paints its own pin and fire canvas in a shadow root', () => {
    const el = render(22);
    const sh = (el as HTMLElement & { shadowRoot: ShadowRoot | null }).shadowRoot;
    expect(sh).not.toBeNull();
    expect(sh!.querySelector('canvas')).not.toBeNull();
    expect(sh!.querySelector('svg')).not.toBeNull();
  });

  it('registers the custom element exactly once, and survives three mounts', () => {
    expect(customElements.get('fire-badge')).toBeTypeOf('function');
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(FounderBadge, { size: 22 }),
          createElement(FounderBadge, { size: 18 }),
          createElement(FounderBadge, { size: 15 }),
        ),
      ),
    );
    expect(Array.from(host.querySelectorAll('fire-badge')).map((n) => n.getAttribute('size'))).toEqual([
      '22',
      '18',
      '15',
    ]);
  });
});

describe('the vendored design file', () => {
  const VENDOR = join(__dirname, 'fireBadge', 'fire-badge.vendor.js');
  // Recorded in fireBadge/PROVENANCE.md. Re-export the design, do not edit the
  // file: if this fails, either the bytes drifted or the hash + PROVENANCE.md
  // were not updated together.
  const SHA256 = '59aa499f4390aa9de516180df1d4556499e18d3d2829370245357bb67f8b6e67';

  it('is byte-for-byte the owner’s export', () => {
    expect(createHash('sha256').update(readFileSync(VENDOR)).digest('hex')).toBe(SHA256);
    expect(readFileSync(join(__dirname, 'fireBadge', 'PROVENANCE.md'), 'utf8')).toContain(SHA256);
  });

  it('is safe to side-effect-import more than once', () => {
    expect(readFileSync(VENDOR, 'utf8')).toContain("if (customElements.get('fire-badge')) return;");
  });
});

describe('the three boards render the badge beside the company name', () => {
  it('Platinum: beside the coname link/span, keyed on the board data, 22px', () => {
    const src = read('CategorySponsor.tsx');
    expect(src).toContain("import FounderBadge from '@public/components/widgets/FounderBadge'");
    expect(src).toContain('founder: sponsor.founder === true');
    expect(src).toContain('{s.founder && <FounderBadge size={22} />}');
    // beside, not inside: the badge follows the closing of the conditional link
    const row = src.slice(src.indexOf('className="csbA-conamerow"'));
    expect(row.indexOf('<FounderBadge')).toBeGreaterThan(row.indexOf(')}'));
  });

  it('Gold: inside the h3 beside the name text, 18px', () => {
    const src = read('SponsorBlock.tsx');
    expect(src).toContain('{sponsor.founder === true && <FounderBadge size={18} />}');
    expect(src).toContain('<span className={styles.nameText}>{sponsor.supplier_name}</span>');
    const scss = readFileSync(join(COMPONENTS, 'SponsorBlock.module.scss'), 'utf8');
    expect(scss).toMatch(/\.nameText\s*\{\s*@include truncate;/);
    // The h3 inherits `truncate`'s overflow:hidden from the shared `.name,
    // .title` block and clipped the fire (measured 40px off the top at 18px).
    // The ellipsis lives on .nameText, so lifting it here is the whole fix.
    expect(scss).toMatch(/\.name\s*\{[^}]*overflow:\s*visible/);
  });

  it('Silver: beside the chip name, 15px, carried on the chip data', () => {
    const src = read('SilverPartners.tsx');
    expect(src).toContain('founder: s.founder === true');
    expect(src).toContain('{s.founder && <FounderBadge size={15} />}');
  });

  it('the payload types name the flag as optional-nullable on all three shapes', () => {
    const types = readFileSync(join(__dirname, '..', '..', 'types', 'sponsor.ts'), 'utf8');
    expect(types.match(/founder\?: boolean \| null;/g)).toHaveLength(3);
  });

  it('the module rule exists (vitest css is off — read it from disk)', () => {
    const scss = readFileSync(join(__dirname, 'FounderBadge.module.scss'), 'utf8');
    expect(scss).toMatch(/\.badge\s*\{[^}]*flex:\s*0 0 auto/);
    expect(scss).toMatch(/vertical-align:\s*-0\.18em/);
    expect(scss).toMatch(/overflow:\s*visible/);
  });
});
