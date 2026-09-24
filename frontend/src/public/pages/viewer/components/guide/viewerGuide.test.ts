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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BomRow, MatchLineIn } from '@public/services/bom/types';
import type { ParseResult } from '@public/services/bom/parseBom';
import { INTAKE_MESSAGES } from '@public/services/kicad/project';
import { INTAKE_CAPS, KICAD5_MESSAGE, MIN_KICAD_VERSION } from '@public/services/kicad/types';
import { rejectionCopy } from '../../intakeCopy';
import { VIEW_LABEL, VIEW_ORDER, viewsFor } from '../../viewLabels';
import ViewerIntake from '../ViewerIntake';
import { CAPS, PRICING_FIELDS, PRIVACY_SENTENCE, proseMb } from './guideCopy';
import { GUIDE_KEY } from './guideState';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    await mount();
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await act(async () => toggle().click());
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
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
    expect(text()).toContain(`Up to ${INTAKE_CAPS.files} files, ${proseMb(INTAKE_CAPS.totalBytes)} MB`);
    expect(text()).toContain(
      `Up to ${INTAKE_CAPS.files} KiCad files, ${proseMb(INTAKE_CAPS.perFileBytes)} MB each, ${proseMb(INTAKE_CAPS.totalBytes)} MB together`,
    );
    expect(CAPS.perFileMb).toBe('8');
    // The components hold no typed number: every figure arrives through CAPS.
    for (const [file, src] of guideSources().filter(([f]) => /(GuideNotes|ViewerIntake)\.tsx$/.test(f))) {
      expect(src, file).not.toMatch(/\b(40|60)\b|\b(8|12) MB\b|KiCad [56]\b/);
    }
  });

  it('prints the turned-away examples from the reader’s own sentences', async () => {
    await mount();
    const shown = [...container.querySelectorAll('details li')].map((li) => li.textContent ?? '');
    const all = shown.join('\n');
    expect(all).toContain(KICAD5_MESSAGE);
    expect(all).toContain(rejectionCopy('glasgow-F_Cu.gbr'));
    expect(all).toContain(rejectionCopy('glasgow.step'));
    expect(all).toContain(INTAKE_MESSAGES.empty);
    expect(all).toContain(INTAKE_MESSAGES.tooManyFiles(INTAKE_CAPS.files + 8));
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
    for (const cls of ['tree', 'outputs', 'notes', 'tour']) expect(scss).toContain(`.${cls}[hidden]`);
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

  it('keeps the table’s screen-reader text inside its scroller (a phone once grew to 441px)', () => {
    expect(scss).toMatch(/\.tableWrap\s*\{[^}]*position: relative;/);
  });

  it('puts the buttons first on a phone, and the folder listing last', () => {
    const phone = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(phone).toMatch(/\.folderCol \.actions\s*\{\s*order: 2;/);
    expect(phone).toMatch(/\.specs\s*\{\s*order: 3;/);
    expect(phone).toMatch(/\.tree\s*\{\s*order: 6;/);
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
