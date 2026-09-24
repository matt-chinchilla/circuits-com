// @vitest-environment happy-dom
/**
 * The /viewer guide ("the project sheet"), rendered for real: the collapse and
 * its memory, the copy that must be true, the numbers that must come from the
 * code, and the privacy disclosure pinned to the request the page really sends.
 *
 * No JSX (vitest only discovers *.test.ts here) and no testing-library —
 * createRoot + act, the harness DesignCanvas.test.ts established. vitest runs
 * with `css: false`, so a CSS-module class proves nothing; the layout rules
 * that matter are witnessed in the SCSS source at the bottom.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { BomRow, MatchLineIn } from '@public/services/bom/types';
import type { ParseResult } from '@public/services/bom/parseBom';
import { INTAKE_MESSAGES } from '@public/services/kicad/project';
import { INTAKE_CAPS, KICAD5_MESSAGE, KicadReadError, MIN_KICAD_VERSION } from '@public/services/kicad/types';
import { EXAMPLE_CREDIT, EXAMPLE_URL, rejectionCopy } from '../../intakeCopy';
import { VIEW_LABEL, VIEW_ORDER, viewsFor } from '../../viewLabels';
import ViewerIntake from '../ViewerIntake';
import { CAPS, PRICING_FIELDS, PRIVACY_SENTENCE, PROJECT_NAME, TOUR_REF, proseMb } from './guideCopy';
import { GUIDE_KEY } from './guideState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The reader, replaceable per test: the tour's link is proven against a read
// that succeeds and one that refuses, without parsing a real project here.
const kicad = vi.hoisted(() => ({ build: vi.fn<(files: File[]) => Promise<unknown>>() }));
vi.mock('@public/services/kicad/project', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@public/services/kicad/project')>()),
  buildProject: (files: File[]) => kicad.build(files),
}));

// The pricing request, captured: the disclosure is pinned to what is SENT.
const sent: { match: MatchLineIn[][] } = { match: [] };
vi.mock('@public/services/bom/bomApi', () => ({
  bomApi: {
    match: (lines: MatchLineIn[]) => {
      sent.match.push(lines);
      return new Promise<BomRow[]>(() => {});
    },
    streamResolve: () => new Promise<void>(() => {}),
  },
}));

let container: HTMLDivElement;
let root: Root;

async function mount(node: ReactNode = createElement(ViewerIntake, { onProject: () => {} })) {
  await act(async () => {
    root.render(node);
  });
}

const text = () => container.textContent ?? '';
const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-controls]')!;
const byText = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label) ?? null;

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // no storage in this run
  }
  sent.match = [];
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

// ─── The collapse ───────────────────────────────────────────────────────────

describe('the guide collapses', () => {
  it('is shown on a first visit, with a real toggle that names what it controls', async () => {
    await mount();
    const t = toggle();
    expect(t.textContent).toContain('Hide the guide');
    expect(t.getAttribute('aria-expanded')).toBe('true');
    const ids = t.getAttribute('aria-controls')!.split(' ');
    expect(ids.length).toBeGreaterThanOrEqual(4);
    // Every id names an element that exists — folded regions are hidden, never unmounted.
    for (const id of ids) expect(document.getElementById(id), id).not.toBeNull();
    for (const id of ids) expect(document.getElementById(id)!.hidden, id).toBe(false);
  });

  it('"Hide the guide" folds to the compact card, and "How it works" brings it back', async () => {
    await mount();
    await act(async () => toggle().click());
    const t = toggle();
    expect(t.getAttribute('aria-expanded')).toBe('false');
    expect(t.textContent).toContain('How it works');
    for (const id of t.getAttribute('aria-controls')!.split(' ')) expect(document.getElementById(id)!.hidden, id).toBe(true);
    // Focus stays on the control that was pressed: it is the same element.
    expect(container.querySelectorAll('button[aria-controls]')).toHaveLength(1);

    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('remembers the choice per browser', async () => {
    await mount();
    await act(async () => toggle().click());
    expect(localStorage.getItem(GUIDE_KEY)).toBe('hidden');
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('renders shown, and still toggles, when storage throws', async () => {
    localStorage.setItem(GUIDE_KEY, 'hidden');
    const get = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const set = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    try {
      await mount();
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      await act(async () => toggle().click());
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
    } finally {
      // Explicitly: restoreAllMocks does not hand happy-dom's Storage back its
      // methods, and a later test reading storage would meet "denied".
      get.mockRestore();
      set.mockRestore();
    }
  });

  it('renders shown when the storage object itself cannot be reached', async () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    await mount();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    spy.mockRestore();
  });

  it('keeps the drop zone and both buttons, working, in BOTH states', async () => {
    await mount();
    for (const state of ['open', 'closed']) {
      expect(container.querySelector('input[type="file"]'), state).not.toBeNull();
      expect(byText('Choose files')?.disabled, state).toBe(false);
      expect(byText('Try the example project')?.disabled, state).toBe(false);
      const sheet = container.querySelector('section[aria-label="Open a KiCad project"]')!;
      expect(sheet.getAttribute('role'), state).toBe('region');
      expect(sheet.getAttribute('data-guide'), state).toBe(state);
      await act(async () => toggle().click());
    }
  });

  it('a note marker opens the guide to show its note WITHOUT forgetting "Hide the guide"', async () => {
    await mount();
    await act(async () => toggle().click());
    expect(localStorage.getItem(GUIDE_KEY)).toBe('hidden');
    const marker = container.querySelector<HTMLAnchorElement>('a[aria-label="Note 4"]')!;
    await act(async () => marker.click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem(GUIDE_KEY)).toBe('hidden');
    // The toggle itself still remembers.
    await act(async () => toggle().click());
    await act(async () => toggle().click());
    expect(localStorage.getItem(GUIDE_KEY)).toBe('shown');
  });

  it('a note marker in the compact card reopens the guide, and never touches the URL hash', async () => {
    await mount();
    await act(async () => toggle().click());
    const before = window.location.hash;
    const marker = container.querySelector<HTMLAnchorElement>('a[aria-label="Note 2"]')!;
    await act(async () => marker.click());
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(window.location.hash).toBe(before);
  });
});

// ─── The folder listing ─────────────────────────────────────────────────────

describe('the "left out" group', () => {
  const stubMedia = (matches: (q: string) => boolean) =>
    vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) => ({ matches: matches(query), media: query }) as unknown as MediaQueryList,
    );
  const leftOut = () => [...container.querySelectorAll('details')].find((d) => d.textContent?.includes('Left out'))!;

  it('starts open on a tall desktop screen', async () => {
    stubMedia(() => false);
    await mount();
    expect(leftOut().open).toBe(true);
  });

  it('starts folded on a laptop-height screen, so the buttons stay above the fold', async () => {
    stubMedia((q) => /max-height:\s*900px/.test(q) && q.includes('max-width: 768px'));
    await mount();
    expect(leftOut().open).toBe(false);
  });

  it('keeps its note marker OUT of the summary (a link inside the disclosure button is nested-interactive)', async () => {
    await mount();
    const summary = leftOut().querySelector('summary')!;
    expect(summary.querySelector('a, button')).toBeNull();
    expect(summary.textContent).toBe('Left out, never read');
    // …but the marker is still right there, on the same row.
    expect(leftOut().parentElement!.querySelector('a[aria-label="Note 3"]')).not.toBeNull();
  });
});

// ─── A refusal ──────────────────────────────────────────────────────────────

describe('a turned-away drop', () => {
  it('says so beside the buttons, not below the whole sheet', async () => {
    const scrolled = vi.fn();
    const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (o?: unknown) => void };
    const had = proto.scrollIntoView;
    proto.scrollIntoView = scrolled;
    onTestFinished(() => {
      proto.scrollIntoView = had;
    });
    await mount();
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const step = new File(['ISO-10303-21;'], 'board.step', { type: 'model/step' });
    Object.defineProperty(input, 'files', { value: [step], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    const alert = container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toBe(rejectionCopy('board.step'));
    expect(scrolled).toHaveBeenCalledWith({ block: 'nearest' });
    // Inside the drop card, straight after the buttons.
    const sheet = container.querySelector('section[aria-label="Open a KiCad project"]')!;
    expect(sheet.contains(alert)).toBe(true);
    expect(alert.previousElementSibling?.querySelector('button')?.textContent).toBe('Choose files');
  });

  it('is placed after the buttons and before the ratings in the source, both layouts', () => {
    const tsx = readFileSync(join(__dirname, '..', 'ViewerIntake.tsx'), 'utf8');
    const actions = tsx.indexOf('styles.actions}');
    const alert = tsx.indexOf('role="alert"');
    const specs = tsx.indexOf('className={styles.specs}');
    expect(actions).toBeGreaterThan(-1);
    expect(alert).toBeGreaterThan(actions);
    expect(specs).toBeGreaterThan(alert);
  });
});

// ─── What the page says ─────────────────────────────────────────────────────

describe('the copy', () => {
  it('carries the binding privacy sentence verbatim on the drop card, in both states', async () => {
    expect(PRIVACY_SENTENCE).toBe('Your design files never leave your browser.');
    await mount();
    const sheet = () => container.querySelector('section[aria-label="Open a KiCad project"]')!.textContent ?? '';
    expect(sheet()).toContain(PRIVACY_SENTENCE);
    await act(async () => toggle().click());
    expect(sheet()).toContain(PRIVACY_SENTENCE);
    // …and the fuller disclosure below it, headed by the same sentence.
    expect(container.querySelector('#viewer-privacy-title')?.textContent).toBe(PRIVACY_SENTENCE);
  });

  /** Everything the guide ships, as source. A comment counts too: a phrase
   *  that is only "explained" in a comment is one edit away from the page. */
  const guideSources = (): [string, string][] => {
    const dir = __dirname;
    const files = readdirSync(dir)
      .filter((f) => /\.(tsx?|scss)$/.test(f) && !f.endsWith('.test.ts'))
      .map((f) => join(dir, f));
    files.push(join(dir, '..', 'ViewerIntake.tsx'), join(dir, '..', '..', 'intakeCopy.ts'), join(dir, '..', '..', 'index.tsx'));
    return files.map((f) => [f, readFileSync(f, 'utf8')]);
  };

  it('never promises what the code does not do (copy guard)', async () => {
    const banned = [/no upload/i, /nothing is sent/i, /nothing, until/i, /live catalog prices/i, /drag the (project )?folder/i];
    for (const [file, src] of guideSources()) {
      for (const re of banned) expect(src, `${file} says ${re}`).not.toMatch(re);
    }
    await mount();
    for (const re of banned) expect(text()).not.toMatch(re);
  });

  it('prints the caps and the minimum KiCad version from the reader’s constants, never as literals', async () => {
    await mount();
    expect(text()).toContain(`KiCad ${MIN_KICAD_VERSION} or newer`);
    // The drop card's own line (note 4's title starts with the same words, so
    // the assertion is scoped to the card): only KiCad files count.
    const card = container.querySelector('section[aria-label="Open a KiCad project"]')!;
    const capsLine = [...card.querySelectorAll('p')].find((p) => p.textContent?.includes('or newer'))!;
    expect(capsLine.textContent).toContain(`Up to ${INTAKE_CAPS.files} KiCad files, ${proseMb(INTAKE_CAPS.totalBytes)} MB`);
    expect(text()).not.toContain(`Up to ${INTAKE_CAPS.files} files,`);
    // Note 4 on the trace: the file cap as its title, the sizes under it.
    const note4 = container.querySelector('#note-4')!.textContent ?? '';
    expect(note4).toContain(`Up to ${INTAKE_CAPS.files} KiCad files`);
    expect(note4).toContain(`${proseMb(INTAKE_CAPS.perFileBytes)} MB each, ${proseMb(INTAKE_CAPS.totalBytes)} MB together`);
    expect(CAPS.perFileMb).toBe('8');
    // The components hold no typed number: every figure arrives through CAPS.
    for (const [file, src] of guideSources().filter(([f]) => /(GuideNotes|ViewerIntake)\.tsx$/.test(f))) {
      expect(src, file).not.toMatch(/\b(40|60)\b|\b(8|12) MB\b|KiCad [56]\b/);
    }
  });

  it('never advertises the zip-bomb guard', async () => {
    await mount();
    expect(text()).not.toMatch(/zip itself|compressed more than|declares more than|archive is/i);
    const copy = readFileSync(join(__dirname, 'guideCopy.ts'), 'utf8');
    expect(copy).not.toMatch(/ARCHIVE_GUARD/);
  });

  it('credits the .kicad_pro with only what it gives: the name and the root sheet (sheet labels are file names)', async () => {
    await mount();
    expect(text()).not.toMatch(/sheet names/i);
    expect(text()).toContain('The project’s name and which sheet is the root');
  });

  it('says where a line the catalog cannot match goes, and where part photos load from', async () => {
    await mount();
    const body = container.querySelector('#viewer-privacy-title')!.parentElement!.textContent ?? '';
    expect(body).toMatch(/looked up at our distributors/);
    expect(body).toMatch(/photos load from the distributors/);
  });

  it('prints the turned-away examples from the reader’s own sentences', async () => {
    await mount();
    const shown = [...container.querySelectorAll('details li')].map((li) => li.textContent ?? '');
    const all = shown.join('\n');
    expect(all).toContain(KICAD5_MESSAGE);
    expect(all).toContain(rejectionCopy(`${PROJECT_NAME}-F_Cu.gbr`));
    expect(all).toContain(rejectionCopy(`${PROJECT_NAME}.step`));
    expect(all).toContain(INTAKE_MESSAGES.empty);
    expect(all).toContain(INTAKE_MESSAGES.tooManyFiles(INTAKE_CAPS.files + 8));
  });

  // Owner, 2026-09-24: the file names the guide shows are generic. The example
  // is named once, by its credit line, because that is what the button loads.
  it('names the example project only in its credit line', async () => {
    await mount();
    const seen = [
      text().split(EXAMPLE_CREDIT).join(''),
      ...[...container.querySelectorAll('[alt], [aria-label], [title]')].map((el) =>
        ['alt', 'aria-label', 'title'].map((a) => el.getAttribute(a) ?? '').join(' '),
      ),
    ].join('\n');
    expect(text()).toContain(EXAMPLE_CREDIT);
    expect(seen).not.toMatch(/glasgow|io_banks|io_buffer/i);
    expect(text()).toContain(`${PROJECT_NAME}/`);
  });

  it('states what each kind of drop opens with the SAME rule the workspace uses', async () => {
    expect(viewsFor(true, false)).toEqual(['schematic', 'bom']);
    expect(viewsFor(false, true)).toEqual(['board', 'stackup', 'board3d']);
    expect(viewsFor(true, true)).toEqual(VIEW_ORDER);
    await mount();
    const table = container.querySelector('table')!;
    const heads = [...table.querySelectorAll('thead th')].slice(1).map((th) => th.textContent);
    expect(heads).toEqual(VIEW_ORDER.map((id) => VIEW_LABEL[id]));
    const rows = [...table.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.getAttribute('data-yes') === 'true'),
    );
    expect(rows).toEqual([
      VIEW_ORDER.map((id) => viewsFor(true, false).includes(id)),
      VIEW_ORDER.map((id) => viewsFor(false, true).includes(id)),
      VIEW_ORDER.map(() => true),
    ]);
  });

  it('gives every capture its own size, so nothing shifts as they load, and lazy-loads them', async () => {
    await mount();
    const imgs = [...container.querySelectorAll('img')];
    expect(imgs.length).toBeGreaterThanOrEqual(8);
    for (const img of imgs) {
      expect(Number(img.getAttribute('width')), img.src).toBeGreaterThan(0);
      expect(Number(img.getAttribute('height')), img.src).toBeGreaterThan(0);
      expect(img.getAttribute('loading'), img.src).toBe('lazy');
      expect(img.getAttribute('alt')?.length ?? 0, img.src).toBeGreaterThan(20);
      // …and each is a file that exists, at the size declared.
      const file = join(__dirname, '../../../../../../public', img.getAttribute('src')!);
      expect(readFileSync(file).length, file).toBeGreaterThan(1000);
    }
  });
});

// ─── The tour's way in ───────────────────────────────────────────────────────
// The drop card's pair is docked at the bottom of the screen whenever the tour
// is in view, so the tour does not end on a second "Try the example project":
// it ends on the part it followed, opened live.

describe('the tour’s way in', () => {
  const tour = () => document.getElementById('viewer-guide-tour')!;
  const seeLink = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === `See ${TOUR_REF} on the example`)!;
  const example = () => ({ ok: true, blob: async () => new Blob(['zip']) });

  beforeEach(() => {
    kicad.build.mockReset();
    window.location.hash = '';
  });

  it('ends on "See U30 on the example", not on a copy of the docked pair', async () => {
    await mount();
    expect(TOUR_REF).toBe('U30');
    expect([...tour().querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual([
      `See ${TOUR_REF} on the example`,
    ]);
    expect(tour().textContent).not.toContain('Try the example project');
    expect(tour().textContent).toContain(`Pick ${TOUR_REF} on any view`);
    // The button lands on the panel UNPRICED ("Price the BOM to see its catalog
    // match"); the pictured catalog section is one click on, and the copy says so.
    expect(tour().textContent).toContain('once the BOM is priced, what our catalog knows about it');
    expect(tour().textContent).toContain('the catalog match once the BOM is priced');
    // Exactly one "Try the example project" on the whole intake: the pair's.
    expect(
      [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Try the example project'),
    ).toHaveLength(1);
  });

  // The page owns the URL: it focuses the part and mirrors it into the hash
  // (replaced, not pushed — see viewerPage.test.ts). A hash written here was a
  // pushed history entry, and a no-op on every visit after the first.
  it('hands U30 over WITH the project, and writes no history of its own', async () => {
    const opened: unknown[][] = [];
    await mount(createElement(ViewerIntake, { onProject: (...args: unknown[]) => opened.push(args) }));
    const fetched = vi.fn(async () => example());
    vi.stubGlobal('fetch', fetched);
    const project = { name: 'stub' };
    const before = history.length;
    for (const visit of [1, 2]) {
      kicad.build.mockResolvedValueOnce(project);
      await act(async () => {
        seeLink().click();
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(opened, `visit ${visit}`).toHaveLength(visit);
      expect(opened.at(-1), `visit ${visit}`).toEqual([project, TOUR_REF]);
    }
    expect(fetched).toHaveBeenCalledWith(EXAMPLE_URL);
    expect(kicad.build).toHaveBeenCalledTimes(2);
    expect(window.location.hash).toBe('');
    expect(history.length).toBe(before);
  });

  it('hands nothing over when the example is refused, and no part when the pair’s own button opens it', async () => {
    const opened = vi.fn();
    await mount(createElement(ViewerIntake, { onProject: opened }));
    vi.stubGlobal('fetch', async () => example());

    kicad.build.mockRejectedValueOnce(new KicadReadError('refused', 'unreadable'));
    await act(async () => {
      seeLink().click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('refused');
    expect(opened).not.toHaveBeenCalled();

    const project = { name: 'stub' };
    kicad.build.mockResolvedValueOnce(project);
    await act(async () => {
      byText('Try the example project')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith(project, undefined);
    expect(window.location.hash).toBe('');
  });
});

// ─── The privacy disclosure, pinned to the real request ──────────────────────

describe('what pricing sends', () => {
  it('is exactly the disclosed fields plus a line index — no quantities, no designators', async () => {
    const { useBomWorkbench } = await import('@public/services/bom/useBomWorkbench');
    const parsed: ParseResult = {
      lines: [
        {
          index: 0,
          mpn: 'ICE40HX8K-BG121',
          value: 'FPGA',
          footprint: 'BGA-121',
          description: 'iCE40 FPGA',
          manufacturer: 'Lattice',
          distributorPn: null,
          qty: 3,
          refs: ['U30'],
          dnp: false,
        },
      ],
      headers: [],
      headerSignature: '',
      roleByColumn: [],
      unmappedColumns: [],
      warnings: [],
      error: null,
    };
    function Probe() {
      useBomWorkbench(parsed, null);
      return null;
    }
    await mount(createElement(Probe));
    expect(sent.match).toHaveLength(1);
    const line = sent.match[0]![0]!;
    expect(Object.keys(line).sort()).toEqual(['index', ...Object.keys(PRICING_FIELDS)].sort());
    expect(JSON.stringify(sent.match)).not.toContain('U30');
    expect(Object.values(line)).not.toContain(3);
  });

  it('names those fields, in words, in the disclosure below the sheet', async () => {
    await mount();
    const body = container.querySelector('#viewer-privacy-title')!.parentElement!.textContent ?? '';
    for (const word of Object.values(PRICING_FIELDS)) expect(body).toContain(word);
    expect(body).toMatch(/never its quantities, its designators or the files/);
    expect(body).toMatch(/only when you click it/);
  });
});

// ─── Layout rules the tests cannot see (vitest css: false) ──────────────────

describe('Guide.module.scss', () => {
  const scss = readFileSync(join(__dirname, 'Guide.module.scss'), 'utf8');

  it('re-asserts [hidden] on every folded region that sets its own display', () => {
    for (const cls of ['tree', 'outputs']) expect(scss).toContain(`.${cls}[hidden]`);
  });

  it('animates ONLY inside prefers-reduced-motion: no-preference', () => {
    const start = scss.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(start).toBeGreaterThan(-1);
    const end = scss.indexOf('@keyframes', start);
    const outside = scss.slice(0, start) + scss.slice(end);
    // Outside the block: no running animation at all (only keyframe bodies).
    expect(outside).not.toMatch(/\banimation:\s*(?!none)/);
  });

  it('hides the traces below 1100px, where the cards carry the mapping as text', () => {
    expect(scss).toMatch(/\$bp-traces:\s*1100px/);
    expect(scss).toMatch(/@media \(max-width: \$bp-traces\)\s*\{[\s\S]*?\.traces\s*\{\s*display: none;/);
  });

  it('puts the buttons first on a phone, and the folder listing last', () => {
    const phone = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(phone).toMatch(/\.folderCol \.actions\s*\{\s*order: 2;/);
    expect(phone).toMatch(/\.specs\s*\{\s*order: 3;/);
    expect(phone).toMatch(/\.tree\s*\{\s*order: 6;/);
  });

  /** WCAG relative-luminance contrast of two #rrggbb colours (alpha-free). */
  const contrast = (a: number[], b: number[]): number => {
    const lum = (c: number[]) =>
      c
        .map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const token = (name: string) => rgb(scss.match(new RegExp(`\\$${name}:\\s*(#[0-9a-fA-F]{6})`))![1]!);
  const WHITE = [255, 255, 255];
  const BENCH = rgb('#f2f4f9'); // the drop frame's bench, under the notes

  it('keeps the muted "left out" ink at AA on white and on the bench', () => {
    expect(contrast(token('ink-3'), WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('ink-3'), BENCH)).toBeGreaterThanOrEqual(4.5);
    expect(scss).toMatch(/\.out \{\s*\.name,\s*\.role \{\s*color: \$ink-3;/);
  });

  it('lets a role label take the ellipsis before a file name does', () => {
    expect(scss).toMatch(/\n\.name \{[^}]*flex-shrink: 0;/);
    expect(scss).toMatch(/\n\.role \{[^}]*min-width: 0;[^}]*text-overflow: ellipsis;/);
  });

  it('places a refusal under the buttons in the compact card’s grid and in the phone stack', () => {
    expect(scss).toContain("'error error'");
    expect(scss).toMatch(/\.folderCol \.dropError \{\s*grid-area: error;/);
    const phone = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(phone).toMatch(/\.folderCol \.dropError \{\s*order: 2;/);
  });

  it('puts the buttons before the listing on a short desktop screen too', () => {
    const start = scss.indexOf('and (max-height: 760px)');
    expect(start).toBeGreaterThan(-1);
    const block = scss.slice(start, scss.indexOf('\n}\n', start));
    expect(block).toMatch(/\.folderCol \.actions\s*\{\s*order: 2;/);
    expect(block).toMatch(/\.tree\s*\{\s*order: 6;/);
  });

  it('draws the pulse with no filter (a drop-shadow under a moving dash offset re-rasterises every frame)', () => {
    expect(scss).not.toMatch(/\bfilter:/);
  });

  it('stands the ratings beside the buttons ONLY in the compact card, and only where the traces would draw', () => {
    // The two-column compact layout is gated on the closed state AND on the
    // width above $bp-traces; below it the compact card is the same single
    // stack the open sheet uses, and the open sheet never takes it.
    const start = scss.indexOf('@media (min-width: #{$bp-traces + 1px})');
    expect(start).toBeGreaterThan(-1);
    const block = scss.slice(start, scss.indexOf('\n}\n', start));
    expect(block).toMatch(/\.sheet\[data-guide='closed'\] \.folderCol\s*\{\s*display: grid;/);
    expect(block).toContain("'actions specs'");
    // Nowhere else does the folder column become a grid.
    const outside = scss.slice(0, start) + scss.slice(start + block.length);
    expect(outside).not.toMatch(/\.folderCol\s*\{[^}]*display: grid/);
  });
});
