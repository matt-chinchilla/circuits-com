// @vitest-environment happy-dom
/**
 * The About page's "Why Circuit Center?" rewrite (spec
 * docs/superpowers/specs/2026-09-25-about-page-design.md): the manifesto and
 * commitments rail, the Founder's Deal block with both animated badges and a
 * burning lip that ignites ONCE when the block is seen, and the new closing CTA.
 *
 * DOM tests are createRoot + act with no testing library. A CSS-module class
 * assertion proves nothing here (vitest's `css` is off, the import echoes the
 * key back), so every layout rule is read from the SCSS on disk.
 */
import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HelmetProvider } from 'react-helmet-async';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The three vendor custom elements (<glow-badge>, <fire-badge>, <fire-edge>)
// read `matchMedia` at IMPORT time and build Resize/IntersectionObservers when
// they connect, so the stubs have to beat the imports — hence vi.hoisted (the
// block founderBadge.test.ts uses). The MediaQueryList the vendors capture says
// reduced motion is ON for the whole file, so no vendor rAF loop ever starts;
// the page's own reduced-motion read goes through `state.reduced` instead,
// because the page asks `window.matchMedia` again at mount.
const state = vi.hoisted(() => {
  const noop = () => undefined;
  const s = {
    reduced: false,
    observers: [] as Array<{
      cb: (entries: Array<Record<string, unknown>>) => void;
      options: { threshold?: number | number[] } | undefined;
      targets: Element[];
    }>,
  };
  const mql = (matches: boolean, media: string) => ({
    matches,
    media,
    onchange: null,
    addListener: noop,
    removeListener: noop,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => false,
  });
  class RO {
    observe = noop;
    unobserve = noop;
    disconnect = noop;
    takeRecords = () => [];
  }
  class IO {
    private rec: (typeof s.observers)[number];
    constructor(cb: (entries: Array<Record<string, unknown>>) => void, options?: { threshold?: number | number[] }) {
      this.rec = { cb, options, targets: [] };
      s.observers.push(this.rec);
    }
    observe = (el: Element) => {
      this.rec.targets.push(el);
    };
    unobserve = noop;
    disconnect = () => {
      this.rec.targets = [];
    };
    takeRecords = () => [];
  }
  const g = globalThis as unknown as Record<string, unknown>;
  // Import-time answer for the vendors: reduced motion ON.
  g.matchMedia = (q: string) => mql(true, q);
  g.ResizeObserver = RO;
  g.IntersectionObserver = IO;
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => (key === 'createRadialGradient' ? () => ({ addColorStop: noop }) : noop),
      set: () => true,
    },
  );
  (g.HTMLCanvasElement as { prototype: { getContext: unknown } }).prototype.getContext = () => ctx;
  (s as { IO?: unknown }).IO = IO;
  (s as { mql?: unknown }).mql = mql;
  return s;
});

// The stats strip fetches /api/stats on mount; keep it pending (it degrades to
// dashes) so no request leaves the test.
vi.mock('@public/services/api', () => ({
  api: { getSiteStats: () => new Promise(() => undefined) },
}));

const { default: AboutPage } = await import('./index');
const { useFounderBlock, IGNITE_FALLBACK_MS } = await import('./useFounderBlock');
const { FOUNDER_DEAL_USD } = await import('@public/pages/join/founderDeal');
const { NO_VALUE } = await import('./siteStats');

const SCSS = readFileSync(join(__dirname, 'AboutPage.module.scss'), 'utf8');

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The body of the first `{ … }` block after `head`, braces balanced. */
function block(src: string, head: string): string {
  const at = src.indexOf(head);
  if (at < 0) throw new Error(`missing: ${head}`);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`unbalanced: ${head}`);
}

/** The chain of block headers (selectors / at-rules) enclosing `index`. */
function enclosing(src: string, index: number): string[] {
  const stack: number[] = [];
  const clean = src.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  for (let i = 0; i < index; i++) {
    if (clean[i] === '{') stack.push(i);
    else if (clean[i] === '}') stack.pop();
  }
  return stack.map(open => {
    const prev = Math.max(clean.lastIndexOf('{', open - 1), clean.lastIndexOf('}', open - 1), clean.lastIndexOf(';', open - 1));
    return squash(clean.slice(prev + 1, open));
  });
}

const setMatchMedia = () => {
  (globalThis as unknown as Record<string, unknown>).matchMedia = (q: string) =>
    (state as unknown as { mql: (m: boolean, q: string) => unknown }).mql(
      q.includes('prefers-reduced-motion') ? state.reduced : false,
      q,
    );
};

describe('AboutPage', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.reduced = false;
    state.observers.length = 0;
    setMatchMedia();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.head.innerHTML = '';
  });

  const render = () => {
    act(() =>
      root.render(
        createElement(
          HelmetProvider,
          null,
          createElement(MemoryRouter, { initialEntries: ['/about'] }, createElement(AboutPage)),
        ),
      ),
    );
  };

  const fireEdge = () => host.querySelector('fire-edge')!;

  /** The page's own observer on the Founder block — an ancestor of the lip,
   *  unlike the lip's own observer (which watches the element itself). */
  const founderObserver = () => {
    const fe = fireEdge();
    const hit = state.observers.filter(o => o.targets.some(t => t !== fe && t.contains(fe)));
    expect(hit).toHaveLength(1);
    return hit[0];
  };

  const intersect = (ratio: number) => {
    const o = founderObserver();
    act(() =>
      o.cb(o.targets.map(target => ({ target, isIntersecting: ratio > 0, intersectionRatio: ratio }))),
    );
  };

  it('says the new manifesto: the display line, the four commitments in order, no old claims', () => {
    render();
    const text = host.textContent ?? '';
    expect(text).toContain('The places engineers look for parts stopped competing years ago. We didn’t.');
    expect(text).toContain('Circuit Center is new. It started in 2026');
    const claims = [...host.querySelectorAll('ul h3')].map(h => h.textContent);
    expect(claims).toEqual([
      'A way up for the businesses still growing',
      'We only grow when you do',
      'Useful feedback gets paid',
      'Something new ships every day',
    ]);
    // The retired copy ("For over two decades, Circuit Center has been the
    // go-to resource…") claimed a history the company does not have. The new
    // manifesto says "two decades" about the INCUMBENTS, so the guard is the
    // claim itself, not the phrase.
    expect(text).not.toMatch(/over two decades/i);
    expect(text).not.toMatch(/go-to resource/i);
    expect(text).not.toContain('Ready to Get Listed?');
    expect(text).toContain(
      'That is why we hold ourselves to a standard for quality and customer experience that almost no industry bothers to reach.',
    );
    expect(text).toContain(
      'When it is useful, we pay for it, in money and in benefits tailored to your company, like a company page designed for you on Circuit Center or an engineer\u2019s time on your data pipeline, at no charge.',
    );
    // the last commitment's contact link
    expect(host.querySelector('ul a[href="/contact"]')?.textContent).toBe('contact page');
  });

  it('renders the Founder block: both badges at 64px, the three Founder prices, and both links', () => {
    render();
    const glow = host.querySelectorAll('glow-badge');
    const fire = host.querySelectorAll('fire-badge');
    expect(glow).toHaveLength(1);
    expect(fire).toHaveLength(1);
    expect(glow[0].getAttribute('size')).toBe('64');
    expect(fire[0].getAttribute('size')).toBe('64');
    expect(fire[0].getAttribute('badge')).toBe('true');
    expect(fire[0].getAttribute('sparks')).toBe('true');
    const pair = glow[0].parentElement!;
    expect(pair.getAttribute('role')).toBe('img');
    expect(pair.getAttribute('aria-label')).toBe('Founder’s Badge, pulsing and burning variants');
    expect(pair.contains(fire[0])).toBe(true);

    const block = fireEdge().parentElement!.parentElement!;
    const blockText = block.textContent ?? '';
    for (const price of Object.values(FOUNDER_DEAL_USD)) expect(blockText).toContain(price);
    expect(blockText).toContain(
      `Silver is ${FOUNDER_DEAL_USD.silver} a month, Gold is ${FOUNDER_DEAL_USD.gold} and Platinum is ${FOUNDER_DEAL_USD.platinum}. That number never goes up.`,
    );
    expect(block.textContent).toContain('Fd · Founder’s Deal');
    const claim = block.querySelector('a[href="/join?founder=1"]');
    expect(claim?.textContent).toBe('Claim the Founder’s Deal');
    expect(block.querySelector('a[href="/contact"]')?.textContent).toBe('Talk to us');
  });

  it('speaks without dashes: no em or en dash in any visible sentence (owner register rule)', () => {
    render();
    // The stats strip's placeholder is a glyph, not a statement; it is the
    // only dash allowed (the api stub keeps the figures pending, so it shows).
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const sentences: string[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent ?? '';
      if (t.trim() !== NO_VALUE) sentences.push(t);
    }
    const offenders = sentences.filter(t => /[\u2013\u2014]/.test(t));
    expect(offenders).toEqual([]);
    const aria = [...host.querySelectorAll('[aria-label]')].map(e => e.getAttribute('aria-label') ?? '');
    expect(aria.filter(t => /[\u2013\u2014]/.test(t))).toEqual([]);
    // How It Works' Connect card, rewritten without its dash
    expect(host.textContent).toContain(
      'Click through to the distributor of your choice in a new tab. We never gate the buy link, so your relationship stays with them.',
    );
  });

  it('closes on a person, not a queue', () => {
    render();
    const headings = [...host.querySelectorAll('h2')].map(h => h.textContent);
    expect(headings).toContain('Reach a person, not a queue.');
    const cta = [...host.querySelectorAll('section')].pop()!;
    expect(cta.querySelector('a[href="/contact"]')?.textContent).toBe('Talk to us');
    expect(cta.querySelector('a[href="/search"]')?.textContent).toBe('Browse parts');
    expect(cta.textContent).not.toContain('→');
  });

  it('keeps the lip cold until the block is seen, then lights it once and for good', () => {
    render();
    expect(fireEdge().getAttribute('active')).toBe('false');
    expect(fireEdge().getAttribute('mode')).toBe('lip');

    intersect(0.1); // in view, but not a third of it
    expect(fireEdge().getAttribute('active')).toBe('false');

    intersect(0.35);
    expect(fireEdge().getAttribute('active')).toBe('true');

    intersect(0); // scrolled away — the fire does not go out
    expect(fireEdge().getAttribute('active')).toBe('true');
  });

  it('never lights the lip under reduced motion', () => {
    state.reduced = true;
    render();
    intersect(1);
    expect(fireEdge().getAttribute('active')).toBe('false');
  });

  it('cycles the badge colours only while the block is on screen', () => {
    vi.useFakeTimers();
    try {
      render();
      const scheme = () => host.querySelector('glow-badge')!.getAttribute('scheme');
      const first = scheme();
      act(() => vi.advanceTimersByTime(6000));
      expect(scheme()).toBe(first); // not seen yet

      intersect(0.5);
      act(() => vi.advanceTimersByTime(3000));
      const second = scheme();
      expect(second).not.toBe(first);
      expect(host.querySelector('fire-badge')!.getAttribute('scheme')).toBe(second);

      intersect(0);
      act(() => vi.advanceTimersByTime(9000));
      expect(scheme()).toBe(second);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useFounderBlock without an IntersectionObserver', () => {
  let host: HTMLDivElement;
  let root: Root;
  let seen: { ignited: boolean; onScreen: boolean } | null;

  function Probe() {
    const ref = useRef<HTMLDivElement | null>(null);
    seen = useFounderBlock(ref);
    return createElement('div', { ref });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    state.reduced = false;
    setMatchMedia();
    seen = null;
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = undefined;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = (
      state as unknown as { IO: unknown }
    ).IO;
    vi.useRealTimers();
  });

  it(`treats the block as seen and ignites ${IGNITE_FALLBACK_MS}ms after mount`, () => {
    act(() => root.render(createElement(Probe)));
    expect(seen).toEqual({ ignited: false, onScreen: true });
    act(() => vi.advanceTimersByTime(IGNITE_FALLBACK_MS - 1));
    expect(seen?.ignited).toBe(false);
    act(() => vi.advanceTimersByTime(1));
    expect(seen?.ignited).toBe(true);
  });

  it('still never ignites under reduced motion', () => {
    state.reduced = true;
    act(() => root.render(createElement(Probe)));
    act(() => vi.advanceTimersByTime(IGNITE_FALLBACK_MS * 4));
    expect(seen).toEqual({ ignited: false, onScreen: true });
  });
});

describe('AboutPage.module.scss', () => {
  it('the Why section is the field’s positioned, clipping parent; the content sits above it', () => {
    const why = squash(block(SCSS, '.aboutWhy {'));
    expect(why).toContain('position: relative;');
    expect(why).toContain('overflow: hidden;');
    const inner = squash(block(SCSS, '.aboutWhyInner {'));
    expect(inner).toContain('position: relative;');
    expect(inner).toContain('z-index: 1;');
  });

  it('the Founder block never clips its badges’ fire or its lip', () => {
    const fb = squash(block(SCSS, '.founderBlock {'));
    expect(fb).toContain('overflow: visible;');
    expect(fb).toContain('position: relative;');
    const lip = squash(block(SCSS, '.founderFire {'));
    expect(lip).toContain('position: absolute;');
    expect(lip).toContain('bottom: -2px;');
    expect(lip).toContain('height: 2px;');
  });

  it("the field's own stylesheet paints the static fallback under [data-caustic='static'] (the page has no copy)", () => {
    expect(SCSS).not.toContain("data-caustic");
    const fieldScss = readFileSync(join(__dirname, 'CausticField.module.scss'), 'utf8');
    const fallback = squash(block(fieldScss, "&[data-caustic='static'] {"));
    expect(fallback).toMatch(/radial-gradient\(.*var\(--theme-accent\) 14%/);
    expect(fallback).toMatch(/radial-gradient\(.*var\(--theme-accent\) 10%/);
    expect(fallback).toContain('var(--theme-nav-bg)');
  });

  it('every hover tint outside How It Works lives inside @media (hover: hover)', () => {
    const clean = SCSS.replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
    const hovers = [...clean.matchAll(/:hover/g)].map(m => m.index!);
    const checked = hovers
      .map(i => enclosing(SCSS, i))
      .filter(chain => !chain.some(h => h.startsWith('.aboutStep')));
    // the rail ring, the contact link, both Founder buttons, both CTA buttons
    expect(checked.length).toBeGreaterThanOrEqual(6);
    for (const chain of checked) expect(chain).toContain('@media (hover: hover)');
    // …and the rail row + Founder buttons are among them
    const heads = SCSS.slice(SCSS.indexOf('@media (hover: hover)'));
    expect(heads).toContain('.whyRow:hover .whyPad');
    expect(heads).toContain('.founderBtn:hover');
    expect(heads).toContain('.founderBtnGhost:hover');
  });

  it('the Founder buttons outrank the shared .glowBtn base that resets border to transparent', () => {
    // .glowBtn comes later in the file; a same-specificity rule before it
    // loses its border colour to the base's `border` shorthand.
    expect(squash(block(SCSS, '.glowBtn {'))).toContain('border: 1.5px solid transparent;');
    const ghost = squash(block(SCSS, '.founderActions .founderBtnGhost {'));
    expect(ghost).toContain('border-color: rgba(255, 255, 255, 0.28);');
    const primary = squash(block(SCSS, '.founderActions .founderBtn {'));
    expect(primary).toContain('background: var(--tc-deep);');
    expect(SCSS).not.toMatch(/^\.founderBtn(Ghost)? \{/m);
  });

  it('the dead value-prop grid and its fade are gone', () => {
    for (const cls of ['.aboutWhyLead', '.aboutWhyGrid', '.aboutWhyCard', '.aboutWhyIcon', '.aboutWhy.seen']) {
      expect(SCSS).not.toContain(cls);
    }
    const tsx = readFileSync(join(__dirname, 'index.tsx'), 'utf8');
    expect(tsx).not.toContain('ABOUT_WHY');
    expect(tsx).not.toContain('whyRef');
  });

  it('uses no will-change or CSS filter (site perf rules)', () => {
    const clean = SCSS.replace(/\/\/[^\n]*/g, '');
    expect(clean).not.toMatch(/will-change/);
    expect(clean).not.toMatch(/(^|[\s;{])filter\s*:/);
    expect(clean).not.toMatch(/mix-blend-mode/);
  });
});
