// @vitest-environment happy-dom
/**
 * "Notes on what it reads" as a trace: six numbered pads on one path, each the
 * target of the circled marker that footnotes it on the sheet, with the two
 * long answers folded under it. Rendered for real (createRoot + act, as in
 * viewerGuide.test.ts); the layout rules are witnessed in the SCSS source
 * because vitest runs with `css: false`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODERN_KICAD_EXTENSIONS } from '@public/services/kicad/zip';
import { VIEW_LABEL, viewsFor } from '../../viewLabels';
import ViewerIntake from '../ViewerIntake';
import { REFUSALS } from './guideCopy';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@public/services/bom/bomApi', () => ({
  bomApi: { match: () => new Promise(() => {}), streamResolve: () => new Promise<void>(() => {}) },
}));

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
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
});

const notes = () => container.querySelector<HTMLElement>('section[aria-labelledby="viewer-notes-title"]')!;
const stations = () => [...notes().querySelectorAll<HTMLLIElement>('ol > li')];

describe('the notes, as a path', () => {
  it('are six numbered stations in order on one ordered list, each a note the markers can reach', () => {
    const list = stations();
    expect(list.map((li) => li.id)).toEqual(['note-1', 'note-2', 'note-3', 'note-4', 'note-5', 'note-6']);
    for (const [i, li] of list.entries()) {
      // Focusable for the marker's jump, headed by its own title.
      expect(li.getAttribute('tabindex')).toBe('-1');
      expect(li.querySelector('h3')!.textContent).toMatch(new RegExp(`^Note ${i + 1}: `));
      // The number on the pad is drawn, not read twice.
      expect(li.querySelector('[aria-hidden="true"]')!.textContent).toBe(String(i + 1));
    }
  });

  it('keeps every marker on the sheet pointing at a station that exists', () => {
    const markers = [...container.querySelectorAll<HTMLAnchorElement>('a[aria-label^="Note "]')];
    const numbers = [...new Set(markers.map((a) => Number(a.getAttribute('aria-label')!.slice(5))))].sort();
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
    for (const a of markers) {
      const target = document.getElementById(a.getAttribute('href')!.slice(1));
      expect(target, a.getAttribute('href')!).not.toBeNull();
      expect(notes().contains(target)).toBe(true);
    }
  });

  it('draws the two net labels as decoration only', () => {
    const flags = [...notes().querySelectorAll('svg')].map((svg) => svg.closest('[aria-hidden="true"]'));
    expect(flags).toHaveLength(2);
    for (const f of flags) expect(f).not.toBeNull();
  });

  it('names the file types note 3 reads from the reader’s own list', () => {
    const codes = [...notes().querySelectorAll('#note-3 code')].map((c) => c.textContent);
    expect(codes).toEqual([...MODERN_KICAD_EXTENSIONS]);
  });

  it('says what half a project opens with the workspace’s own rule and tab names', () => {
    const note5 = notes().querySelector('#note-5')!.textContent ?? '';
    const say = (ids: string[]) =>
      ids.length === 1 ? ids[0]! : `${ids.slice(0, -1).join(', ')} and ${ids[ids.length - 1]}`;
    expect(note5).toContain(`Sheets alone open ${say(viewsFor(true, false).map((id) => VIEW_LABEL[id]))}`);
    expect(note5).toContain(`a board alone opens ${say(viewsFor(false, true).map((id) => VIEW_LABEL[id]))}`);
    expect(note5).toContain('WebGL2');
  });

  it('folds the long answers under the path, closed until asked, each tagged with its pad', () => {
    const folds = [...notes().querySelectorAll('details')];
    expect(folds).toHaveLength(2);
    for (const d of folds) expect(d.open).toBe(false);
    const [refusals, table] = folds as [HTMLDetailsElement, HTMLDetailsElement];
    expect(refusals.querySelector('summary')!.textContent).toBe('3What a turned-away file looks like');
    expect(refusals.querySelectorAll('li')).toHaveLength(REFUSALS.length);
    expect(table.querySelector('summary')!.textContent).toBe('5What each kind of drop opens');
    expect(table.querySelector('table')).not.toBeNull();
  });

  it('leaves the stations and folds out of the page while the guide is hidden', async () => {
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-controls]')!;
    expect(toggle.getAttribute('aria-controls')).toContain(notes().id);
    await act(async () => toggle.click());
    expect(notes().hidden).toBe(true);
  });
});

// ─── Layout rules the tests cannot see (vitest css: false) ──────────────────

describe('NotesFlow.module.scss', () => {
  const scss = readFileSync(join(__dirname, 'NotesFlow.module.scss'), 'utf8');
  const guide = readFileSync(join(__dirname, 'Guide.module.scss'), 'utf8');
  const tokenIn = (src: string, name: string) => src.match(new RegExp(`\\n\\$${name}:\\s*([^;]+);`))?.[1];

  it('re-asserts [hidden], since the section sets its own layout', () => {
    expect(scss).toContain('.notes[hidden]');
  });

  it('uses the SAME tokens as the sheet it footnotes', () => {
    for (const name of ['ink', 'ink-2', 'ink-3', 'rule', 'pcb', 'trace-rest', 'trace-hot', 'copper']) {
      expect(tokenIn(scss, name), name).toBeDefined();
      expect(tokenIn(scss, name), name).toBe(tokenIn(guide, name));
    }
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
  const token = (name: string) => rgb(tokenIn(scss, name)!);
  const WHITE = [255, 255, 255];
  const BENCH = rgb('#f2f4f9'); // the bench the notes sit on
  const PCB = rgb('#0a4a2e'); // $executive-blue

  it('holds every text colour at AA on the bench', () => {
    for (const name of ['ink', 'ink-2', 'ink-3']) expect(contrast(token(name), BENCH), name).toBeGreaterThanOrEqual(4.5);
    // The pad numbers and fold titles: PCB green on white and on the bench.
    expect(contrast(PCB, WHITE)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(PCB, BENCH)).toBeGreaterThanOrEqual(4.5);
    // A lit pad: white on the PCB green, never on the bright trace green.
    expect(scss).toMatch(/\.pad \{\s*color: #fff;\s*background: \$pcb;/);
    expect(contrast(WHITE, PCB)).toBeGreaterThanOrEqual(4.5);
  });

  it('writes the refusal samples in a red that holds AA on its own tint', () => {
    const red = rgb('#c0392b'); // $error-red
    const tint = red.map((v, i) => 0.07 * v + 0.93 * BENCH[i]!);
    expect(contrast(token('refusal-ink'), tint)).toBeGreaterThanOrEqual(4.5);
    expect(scss).toMatch(/\.refusalMsg \{[^}]*color: \$refusal-ink;/);
  });

  it('keeps the table’s screen-reader text inside its scroller (a phone once grew to 441px)', () => {
    expect(scss).toMatch(/\.tableWrap\s*\{[^}]*position: relative;/);
  });

  it('moves ONLY inside prefers-reduced-motion: no-preference, and never runs an animation', () => {
    const start = scss.indexOf('@media (prefers-reduced-motion: no-preference)');
    expect(start).toBeGreaterThan(-1);
    const end = scss.indexOf('\n}\n', start);
    const outside = scss.slice(0, start) + scss.slice(end);
    expect(outside).not.toMatch(/\btransition:/);
    expect(scss).not.toMatch(/\banimation:/);
    expect(scss).not.toMatch(/\bfilter:/);
  });

  it('runs the path across on a wide screen and down the left edge at and below $bp-path', () => {
    // Six columns on one row: every track of the wide grid is a minmax(0, …fr).
    const wide = scss.match(/\n\.path \{[\s\S]*?grid-template-columns: ([^;]+);/)![1]!;
    expect(wide.match(/minmax\(0, [\d.]+fr\)/g)).toHaveLength(6);
    expect(scss).toMatch(/\$bp-path:\s*1239px;/);
    const start = scss.indexOf('@media (max-width: $bp-path)');
    expect(start).toBeGreaterThan(-1);
    const block = scss.slice(start, scss.indexOf('\n}\n', start));
    expect(block).toMatch(/\.flag \{\s*display: none;/);
    expect(block).toMatch(/\.path \{\s*grid-template-columns: minmax\(0, 1fr\);/);
    expect(block).toMatch(/&::before \{[\s\S]*?width: 2px;\s*height: 100%;/);
  });

  it('stacks each title over its body on a phone', () => {
    const phone = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(phone).toMatch(/\.text \{\s*display: block;/);
    expect(phone).toMatch(/\.folds \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  });

  it('lands a marker’s jump below the sticky header', () => {
    expect(scss).toMatch(/\.station \{[^}]*scroll-margin-top: 100px;/);
  });
});
