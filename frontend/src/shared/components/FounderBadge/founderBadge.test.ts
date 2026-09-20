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

const COMPONENTS = join(__dirname, '..', '..', '..', 'public', 'pages', 'category', 'components');
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

  it('sets the four fire attributes from a look, and none without one', () => {
    act(() =>
      root.render(
        createElement(FounderBadge, {
          size: 22,
          look: {
            key: 'founder_badge_1',
            scheme: 'violet',
            intensity: 1.4,
            opacity: 0.45,
            sparks: false,
            speed: 2.6,
          },
        }),
      ),
    );
    const lit = host.firstElementChild!;
    expect(lit.getAttribute('scheme')).toBe('violet');
    expect(lit.getAttribute('intensity')).toBe('1.4');
    expect(lit.getAttribute('opacity')).toBe('0.45');
    // the element reads sparks as a STRING attribute, not a boolean presence
    expect(lit.getAttribute('sparks')).toBe('false');

    // sparks true is still spelled out rather than left to the default; an
    // unknown key renders the burning pin
    act(() =>
      root.render(
        createElement(FounderBadge, {
          size: 22,
          look: {
            key: 'founder_badge_9',
            scheme: 'blue',
            intensity: 1,
            opacity: 0.75,
            sparks: true,
            speed: 2.6,
          },
        }),
      ),
    );
    expect(host.firstElementChild!.tagName.toLowerCase()).toBe('fire-badge');
    expect(host.firstElementChild!.getAttribute('sparks')).toBe('true');
    expect(host.firstElementChild!.getAttribute('badge')).toBe('true');

    // and a null look is the same as no look at all — the element defaults
    act(() => root.render(createElement(FounderBadge, { size: 22, look: null })));
    for (const attr of ['scheme', 'intensity', 'opacity', 'sparks']) {
      expect(host.firstElementChild!.hasAttribute(attr)).toBe(false);
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

describe('the pulsing artwork (founder_badge_2)', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it('renders the vendored <glow-badge>: scheme, intensity as glow, speed, same name', () => {
    act(() =>
      root.render(
        createElement(FounderBadge, {
          size: 18,
          look: {
            key: 'founder_badge_2',
            scheme: 'indigo',
            intensity: 1.3,
            opacity: 0.4,
            sparks: false,
            speed: 4.2,
          },
        }),
      ),
    );
    const el = host.firstElementChild!;
    expect(el.tagName.toLowerCase()).toBe('glow-badge');
    expect(el.getAttribute('size')).toBe('18');
    expect(el.getAttribute('scheme')).toBe('indigo');
    expect(el.getAttribute('glow')).toBe('1.3');
    expect(el.getAttribute('speed')).toBe('4.2');
    // the fire's own knobs never reach the pulsing element
    for (const attr of ['intensity', 'opacity', 'sparks', 'badge']) {
      expect(el.hasAttribute(attr)).toBe(false);
    }
    expect(el.getAttribute('role')).toBe('img');
    expect(el.getAttribute('aria-label')).toBe(FOUNDER_BADGE_LABEL);
    expect(el.className).toMatch(/badge/);
    expect(customElements.get('glow-badge')).toBeTypeOf('function');
  });
});

describe('the vendored pulsing design file', () => {
  const DIR = join(__dirname, 'glowBadge');
  const VENDOR = join(DIR, 'glow-badge.vendor.js');
  // Recorded in glowBadge/PROVENANCE.md: the export with ONE patched line.
  const SHA256 = 'e94a5783972d53d94a4e973c96aa91d28126c8becba2f52f0f7ebcf9a2bacdf8';
  const PNG_SHA256 = '899f9dbdaf9b334b7be09140b724cc056b0b8e9b77890895709676ef3c0a15c4';

  it('is the owner’s export plus the asset-URL patch and the two owner-asked tunings', () => {
    const src = readFileSync(VENDOR, 'utf8');
    expect(createHash('sha256').update(src).digest('hex')).toBe(SHA256);
    expect(readFileSync(join(DIR, 'PROVENANCE.md'), 'utf8')).toContain(SHA256);
    // the patch: Vite resolves the texture; the page URL never does
    expect(src).toContain("new URL('./dot-grid.png', import.meta.url).href");
    expect(src).not.toContain('document.currentScript');
    expect(src).toContain("if (customElements.get('glow-badge')) return;");
    // halo reach halved (owner, 2026-09-20) and every pin in the same phase
    expect(src).toContain('#h{position:absolute;inset:-42.5%;');
    expect(src).toContain('#h2{position:absolute;inset:-12.5%;');
    expect(src).toContain("this._delay = '0s'");
    expect(src).not.toContain('Math.random() * speed');
  });

  it('ships the dot-grid texture the design draws its enamel with', () => {
    const png = readFileSync(join(DIR, 'dot-grid.png'));
    expect(createHash('sha256').update(png).digest('hex')).toBe(PNG_SHA256);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
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
    expect(src).toContain(
      "import FounderBadge from '@shared/components/FounderBadge/FounderBadge'",
    );
    expect(src).toContain('badge: sponsor.badge ?? null');
    expect(src).toContain('{s.badge && <FounderBadge look={s.badge} size={22} />}');
    // beside, not inside: the badge follows the closing of the conditional link
    const row = src.slice(src.indexOf('className="csbA-conamerow"'));
    expect(row.indexOf('<FounderBadge')).toBeGreaterThan(row.indexOf(')}'));
  });

  it('Gold: inside the h3 beside the name text, 18px', () => {
    const src = read('SponsorBlock.tsx');
    expect(src).toContain('{sponsor.badge && <FounderBadge look={sponsor.badge} size={18} />}');
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
    expect(src).toContain('badge: s.badge ?? null');
    expect(src).toContain('{s.badge && <FounderBadge look={s.badge} size={15} />}');
  });

  it('the payload types name the flag and the look as optional-nullable on all three shapes', () => {
    const types = readFileSync(
      join(__dirname, '..', '..', '..', 'public', 'types', 'sponsor.ts'),
      'utf8',
    );
    expect(types.match(/founder\?: boolean \| null;/g)).toHaveLength(3);
    expect(types.match(/badge\?: BadgeLook \| null;/g)).toHaveLength(3);
    expect(types).toContain("import type { BadgeLook } from '@shared/types/badge'");
  });

  it('the module rule exists (vitest css is off — read it from disk)', () => {
    const scss = readFileSync(join(__dirname, 'FounderBadge.module.scss'), 'utf8');
    expect(scss).toMatch(/\.badge\s*\{[^}]*flex:\s*0 0 auto/);
    expect(scss).toMatch(/vertical-align:\s*-0\.18em/);
    expect(scss).toMatch(/overflow:\s*visible/);
  });
});
