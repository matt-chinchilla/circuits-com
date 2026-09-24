// @vitest-environment happy-dom
/**
 * The drop card's buttons stay on screen (owner: "ALWAYS visible"): ONE pair,
 * which docks to the bottom of the screen while its place on the card is out
 * of view and returns when it is back. Rendered for real through ViewerIntake
 * with a fake IntersectionObserver (happy-dom has no layout), plus source
 * witnesses for the layout rules vitest cannot see (css: false).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXAMPLE_URL } from '../../intakeCopy';
import ViewerIntake from '../ViewerIntake';
import { FOCUS_CLEARANCE, FULLY_IN_VIEW, barCover, stickyTopInset } from './StickyActions';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@public/services/bom/bomApi', () => ({
  bomApi: { match: () => new Promise(() => {}), streamResolve: () => new Promise<void>(() => {}) },
}));

class FakeIO {
  static all: FakeIO[] = [];
  targets: Element[] = [];
  disconnected = false;
  constructor(
    readonly cb: IntersectionObserverCallback,
    readonly opts: IntersectionObserverInit = {},
  ) {
    FakeIO.all.push(this);
  }
  observe(t: Element) {
    this.targets.push(t);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords() {
    return [];
  }
}

const live = () => FakeIO.all.filter((io) => !io.disconnected && io.targets.length > 0);

async function report(inView: boolean, ratio = inView ? 1 : 0) {
  const io = live().at(-1)!;
  await act(async () => {
    io.cb(
      [{ isIntersecting: inView || ratio > 0, intersectionRatio: ratio, target: io.targets[0] } as IntersectionObserverEntry],
      io as unknown as IntersectionObserver,
    );
  });
}

let container: HTMLDivElement;
let root: Root;
/** happy-dom lays nothing out: every element answers this as its height. */
let layoutHeight = 44;

const PAIR = ['Choose files', 'Try the example project'];
/** The drop card's pair — the tour's own "See U30 on the example" link is not part of it. */
const pair = () =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => PAIR.includes(b.textContent?.trim() ?? '') && b.closest('#viewer-guide-tour') == null,
  );
const row = () => pair()[0].parentElement!;
const spacers = () => document.body.querySelectorAll(':scope > [aria-hidden="true"][style*="height"]');

beforeEach(async () => {
  layoutHeight = 44;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => layoutHeight);
  FakeIO.all = [];
  vi.stubGlobal('IntersectionObserver', FakeIO);
  try {
    localStorage.clear();
  } catch {
    // no storage in this run
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ViewerIntake, { onProject: () => {} })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the drop card’s buttons stay on screen', () => {
  it('watches the buttons’ own place on the card, and counts it in view only when ALL of it is', () => {
    const io = live().at(-1)!;
    const slot = io.targets[0];
    expect(slot.contains(pair()[0])).toBe(true);
    expect(slot.contains(pair()[1])).toBe(true);
    expect(io.opts.threshold).toContain(FULLY_IN_VIEW);
    expect(FULLY_IN_VIEW).toBeGreaterThan(0.95);
  });

  it('docks the SAME two buttons when their place leaves the view, and brings them back', async () => {
    const [choose, example] = pair();
    expect(row().getAttribute('data-docked')).toBeNull();

    await report(false);
    expect(row().getAttribute('data-docked')).toBe('true');
    // Not a copy: the very same elements, so focus and reading order survive.
    expect(pair()).toEqual([choose, example]);

    // Half in view is not in view: a cut-off button is not "visible".
    await report(true, 0.5);
    expect(row().getAttribute('data-docked')).toBe('true');

    await report(true, 1);
    expect(row().getAttribute('data-docked')).toBeNull();
    expect(pair()).toEqual([choose, example]);
  });

  it('reads the LATEST record when one callback carries several', async () => {
    const io = live().at(-1)!;
    const slot = io.targets[0];
    await act(async () => {
      io.cb(
        [
          { isIntersecting: false, intersectionRatio: 0, target: slot },
          { isIntersecting: true, intersectionRatio: 1, target: slot },
        ] as IntersectionObserverEntry[],
        io as unknown as IntersectionObserver,
      );
    });
    expect(row().getAttribute('data-docked')).toBeNull();
    await act(async () => {
      io.cb(
        [
          { isIntersecting: true, intersectionRatio: 1, target: slot },
          { isIntersecting: false, intersectionRatio: 0, target: slot },
        ] as IntersectionObserverEntry[],
        io as unknown as IntersectionObserver,
      );
    });
    expect(row().getAttribute('data-docked')).toBe('true');
  });

  it('keeps exactly one pair, one tab stop per button, in every state', async () => {
    for (const inView of [true, false, true]) {
      await report(inView);
      expect(pair().map((b) => b.textContent?.trim())).toEqual(PAIR);
      expect(pair().every((b) => b.tabIndex >= 0 && b.getAttribute('aria-hidden') == null)).toBe(true);
    }
  });

  it('holds the buttons’ place on the card while they are docked, so nothing below moves', async () => {
    const slot = live().at(-1)!.targets[0] as HTMLElement;
    expect(slot.style.height).toBe('');
    await report(false);
    expect(slot.style.height).toMatch(/^\d+px$/);
    await report(true);
    expect(slot.style.height).toBe('');
  });

  it('gives the page back the height the docked bar covers, and takes it away again', async () => {
    expect(spacers().length).toBe(0);
    await report(false);
    expect(spacers().length).toBe(1);
    await report(true);
    expect(spacers().length).toBe(0);
  });

  it('stays inside the drop zone when docked, so a file dropped on it opens like one dropped on the sheet', async () => {
    await report(false);
    const sheet = container.querySelector('section[aria-label="Open a KiCad project"]')!;
    expect(sheet.contains(row())).toBe(true);
  });

  it('runs the same handlers when docked, and mirrors the busy state', async () => {
    await report(false);
    const picked = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    await act(async () => pair()[0].click());
    expect(picked).toHaveBeenCalledTimes(1);

    const fetched = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetched);
    const example = pair()[1];
    await act(async () => example.click());
    expect(fetched).toHaveBeenCalledWith(EXAMPLE_URL);
    const busy = [...row().querySelectorAll('button')];
    expect(busy[0].textContent).toBe('Reading…');
    expect(busy.every((b) => b.disabled)).toBe(true);
    expect(row().getAttribute('data-docked')).toBe('true');
  });

  it('lets go of the observer and the spacer when the intake goes (a project opened)', async () => {
    await report(false);
    const io = live().at(-1)!;
    await act(async () => root.unmount());
    expect(io.disconnected).toBe(true);
    expect(spacers().length).toBe(0);
    root = createRoot(container);
  });

  it('counts a row under the sticky navbar as covered, not visible', () => {
    const header = document.createElement('header');
    header.style.position = 'sticky';
    vi.spyOn(header, 'getBoundingClientRect').mockReturnValue({ bottom: 48 } as DOMRect);
    document.body.prepend(header);
    try {
      expect(stickyTopInset()).toBe(48);
    } finally {
      header.remove();
    }
  });

  // The helper alone proved nothing about the wiring: a dropped rootMargin, or
  // one with its sign flipped, passed every other test here.
  it('builds its observer with the navbar’s height cut off the top, and rebuilds it when that changes', async () => {
    const header = document.createElement('header');
    header.style.position = 'sticky';
    let bottom = 48;
    vi.spyOn(header, 'getBoundingClientRect').mockImplementation(() => ({ bottom }) as DOMRect);
    document.body.prepend(header);
    try {
      await act(async () => root.unmount());
      root = createRoot(container);
      FakeIO.all = [];
      await act(async () => root.render(createElement(ViewerIntake, { onProject: () => {} })));
      const first = live().at(-1)!;
      expect(first.opts.rootMargin).toBe('-48px 0px 0px 0px');

      // A rotation: the phone's navbar is a different height.
      bottom = 56;
      await act(async () => window.dispatchEvent(new Event('resize')));
      expect(first.disconnected).toBe(true);
      expect(live()).toHaveLength(1);
      expect(live()[0].opts.rootMargin).toBe('-56px 0px 0px 0px');
    } finally {
      header.remove();
    }
  });

  // WCAG 2.2 SC 2.4.11: Tab scrolls a control below the fold to the bottom
  // edge — under the bar, unless the root reserves that strip.
  it('reserves the strip the docked bar covers as the root’s scroll padding, and gives it back', async () => {
    const rootStyle = document.documentElement.style;
    expect(rootStyle.scrollPaddingBottom).toBe('');
    await report(false);
    expect(rootStyle.scrollPaddingBottom).toBe(`${barCover(row()) + FOCUS_CLEARANCE}px`);
    expect(Number.parseFloat(rootStyle.scrollPaddingBottom)).toBeGreaterThan(FOCUS_CLEARANCE);
    await report(true);
    expect(rootStyle.scrollPaddingBottom).toBe('');

    await report(false);
    expect(rootStyle.scrollPaddingBottom).not.toBe('');
    await act(async () => root.unmount());
    expect(rootStyle.scrollPaddingBottom).toBe('');
    root = createRoot(container);
  });

  // The dockIn entrance holds the row translateY(10px) low for 0.2s; a box read
  // in the dock's first frame came out 10px short for the whole dock.
  it('measures what the bar covers from layout, not from the box its entrance is still moving', async () => {
    const target = row();
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) =>
      el === target ? ({ bottom: '16px', position: 'fixed' } as CSSStyleDeclaration) : real(el, pseudo),
    );
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight - 50,
      bottom: window.innerHeight + 10,
      height: 60,
    } as DOMRect);
    await report(false);
    expect(barCover(target)).toBe(44 + 16);
    const spacer = spacers()[0] as HTMLElement;
    expect(spacer.style.height).toBe('60px');
    expect(document.documentElement.style.scrollPaddingBottom).toBe(`${60 + FOCUS_CLEARANCE}px`);
  });

  it('keeps the place it holds on the card the height the row would have there NOW', async () => {
    const slot = live().at(-1)!.targets[0] as HTMLElement;
    await report(false);
    expect(slot.style.height).toBe('44px');

    // Desktop to phone while docked: the in-flow pair wraps onto two lines.
    layoutHeight = 98;
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(slot.style.height).toBe('98px');
    // Measured on a copy: the real row never left the dock, and the copy is gone.
    expect(row().getAttribute('data-docked')).toBe('true');
    expect(slot.querySelectorAll('button')).toHaveLength(2);

    await report(true);
    expect(slot.style.height).toBe('');
  });
});

// ─── The layout rules vitest cannot see ─────────────────────────────────────

describe('StickyActions.module.scss', () => {
  const scss = readFileSync(join(__dirname, 'StickyActions.module.scss'), 'utf8');
  const tsx = readFileSync(join(__dirname, 'StickyActions.tsx'), 'utf8');
  const docked = scss.slice(scss.indexOf(".row[data-docked='true'] {"));

  it('docks by position: fixed to the bottom edge, centred WITHOUT a translate (sub-pixel text blur)', () => {
    expect(docked).toMatch(/^\.row\[data-docked='true'\] \{[^}]*position: fixed;/);
    expect(docked).toMatch(/bottom: max\(16px, calc\(env\(safe-area-inset-bottom/);
    expect(scss).not.toMatch(/translateX\(-50%\)|translate\(-50%/);
  });

  it('runs full width on a phone, clear of the home indicator', () => {
    const phone = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(phone).toMatch(/left: 0;\s*right: 0;\s*bottom: 0;/);
    expect(phone).toMatch(/padding: 10px 16px max\(10px, env\(safe-area-inset-bottom/);
  });

  it('animates the dock ONLY inside prefers-reduced-motion: no-preference, and only once', () => {
    const outside = scss.replace(/@media \(prefers-reduced-motion: no-preference\) \{[\s\S]*?\n\}\n/, '');
    expect(outside).not.toMatch(/animation:/);
    expect(scss).toMatch(/animation: dockIn 0\.2s ease-out both;/);
    expect(scss).not.toMatch(/infinite/);
  });

  it('keeps a refusal that scrolls itself into view clear of the docked bar and the navbar', () => {
    expect(scss).toMatch(/\.clearOfBar \{\s*scroll-margin-top: 100px;\s*scroll-margin-bottom: 120px;/);
    const host = readFileSync(join(__dirname, '..', 'ViewerIntake.tsx'), 'utf8');
    expect(host).toMatch(/role="alert"/);
    expect(host).toMatch(/stickyStyles\.clearOfBar/);
  });

  it('never reads what the bar covers off the row’s (animated) box', () => {
    expect(tsx).not.toMatch(/row\.getBoundingClientRect\(\)/);
    expect(tsx.slice(tsx.indexOf('export function barCover'))).toMatch(/row\.offsetHeight/);
  });

  it('holds the slot’s height BEFORE the row leaves the flow', () => {
    const dock = tsx.slice(tsx.indexOf('const dock ='));
    expect(dock.indexOf('slot.style.height = `${row.offsetHeight}px`')).toBeLessThan(dock.indexOf('setDocked(next)'));
  });
});
