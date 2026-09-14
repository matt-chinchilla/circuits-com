// @vitest-environment happy-dom
/**
 * The Stackup panel's wording and geometry (spec §7.3).
 *
 * Every assertion here is a promise this panel makes about HONESTY: that it
 * never prints a figure the file does not carry, never claims a drawing is to
 * scale when it is not, and never leaves a copper layer out of its own count.
 * The fixture is Glasgow revC3's real shape and its real numbers (13 physical
 * rows, 9 measured, 416 through vias, `copper_finish "None"`, an IEEE sum of
 * 1.5999999999999999 against a design thickness of 1.6) because that board is
 * the owner's own acceptance check.
 *
 * No JSX: this is a `*.test.ts` (the only shape vitest discovers here), so
 * elements are built with createElement — the harness BomTable.test.ts uses.
 * Class names are NOT assertable: vitest runs with CSS off and a module import
 * echoes its key back, so a rule that exists only in a deleted stylesheet would
 * still "pass". Where a class has to carry a real declaration, the witness is
 * the SCSS SOURCE (the last describe).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardStackup, StackupRow } from '@public/services/kicad/types';
import { minHeightPx } from './stackupLayout';
import StackupPanel, { labelledBands } from './StackupPanel';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (name: string, type: string, thicknessMm: number | null): StackupRow => ({
  name,
  type,
  thicknessMm,
  material: null,
  epsilonR: null,
  lossTangent: null,
});

/** Glasgow revC3, row for row and thickness for thickness. */
const GLASGOW_ROWS: StackupRow[] = [
  row('F.SilkS', 'Top Silk Screen', null),
  row('F.Paste', 'Top Solder Paste', null),
  row('F.Mask', 'Top Solder Mask', 0.01),
  row('F.Cu', 'copper', 0.035),
  row('dielectric 1', 'prepreg', 0.48),
  row('In1.Cu', 'copper', 0.035),
  row('dielectric 2', 'core', 0.48),
  row('In2.Cu', 'copper', 0.035),
  row('dielectric 3', 'prepreg', 0.48),
  row('B.Cu', 'copper', 0.035),
  row('B.Mask', 'Bottom Solder Mask', 0.01),
  row('B.Paste', 'Bottom Solder Paste', null),
  row('B.SilkS', 'Bottom Silk Screen', null),
];

/** The reader's own sum, reduced in file order over the rows that carry a
 *  thickness — so the raw IEEE value this panel must never print is produced
 *  here the same way `readStackup` produces it, not copied as a literal. */
const LISTED = GLASGOW_ROWS.reduce<number | null>((sum, r) => (r.thicknessMm == null ? sum : (sum ?? 0) + r.thicknessMm), null);

const GLASGOW: BoardStackup = {
  copperLayers: [
    { ordinal: 1, name: 'F.Cu', kind: 'Signal' },
    { ordinal: 2, name: 'In1.Cu', kind: 'Plane' },
    { ordinal: 3, name: 'In2.Cu', kind: 'Plane' },
    { ordinal: 4, name: 'B.Cu', kind: 'Signal' },
  ],
  stackup: GLASGOW_ROWS,
  copperFinish: 'None',
  listedThicknessMm: LISTED,
  designThicknessMm: 1.6,
  vias: [{ type: 'through', start: 'F.Cu', end: 'B.Cu', count: 416 }],
  layerCount: 4,
};

/** A board saved without Board Setup: copper layers and vias, no stackup block. */
const BARE: BoardStackup = { ...GLASGOW, stackup: null, copperFinish: null, listedThicknessMm: null };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(stackup: BoardStackup) {
  act(() => {
    root.render(createElement(StackupPanel, { stackup }));
  });
}

function text(): string {
  return container.textContent ?? '';
}

/** The summary strip as the pairs a reader sees. */
function summaryPairs(): [string, string][] {
  const dl = container.querySelector('dl');
  if (dl == null) throw new Error('no summary');
  const out: [string, string][] = [];
  const dts = [...dl.querySelectorAll('dt')];
  const dds = [...dl.querySelectorAll('dd')];
  dts.forEach((dt, i) => out.push([dt.textContent ?? '', dds[i]?.textContent ?? '']));
  return out;
}

function valueOf(label: string): string | undefined {
  return summaryPairs().find((p) => p[0] === label)?.[1];
}

function labelTexts(): string[] {
  return [...container.querySelectorAll('svg text')].map((t) => t.textContent ?? '');
}

/** Via barrels are the VERTICAL lines in the figure; the label leaders are the
 *  horizontal ones. Partitioned by geometry rather than by class, because
 *  vitest runs with CSS off and a module class is only its own key echoed
 *  back — and because the orientation is the thing that makes a barrel a
 *  barrel. */
function barrels(): Element[] {
  return [...container.querySelectorAll('svg line')].filter((l) => l.getAttribute('x1') === l.getAttribute('x2'));
}

/** Where the board's own left edge is, read off the first band. */
function boardLeft(): number {
  return Number(container.querySelector('svg rect')!.getAttribute('x'));
}

describe('the figures the panel prints', () => {
  it('rounds the listed thickness instead of shipping the raw IEEE sum', () => {
    // The reader's contract is "the sum of what the file lists", kept raw on
    // purpose; rounding is the VIEW's job. Glasgow's nine thicknesses add up
    // to 1.6 in decimal and to a 17-digit tail in binary.
    expect(String(LISTED)).not.toBe('1.6');
    render(GLASGOW);
    expect(valueOf('Listed thickness')).toBe('1.6000 mm');
    expect(text()).not.toMatch(/1\.5999|1\.60000000/);
  });

  it('keeps the listed sum and the design setting as two separate lines', () => {
    // The one comparison the panel exists to show: the file's own sum beside
    // the board's setting. Collapsing them would hide a stackup that no longer
    // adds up to the thickness the board was designed to.
    render(GLASGOW);
    // Same precision as the Thk column above it, which is the point of one
    // shared formatter: the reader can add the rows up and get the total.
    expect(valueOf('Listed thickness')).toBe('1.6000 mm');
    expect(valueOf('Design thickness')).toBe('1.6000 mm');
  });

  it('says a copper finish of "None" is none specified, and never treats it as a finish name', () => {
    render(GLASGOW);
    expect(valueOf('Copper finish')).toBe('none specified');

    render({ ...GLASGOW, copperFinish: '  ' });
    expect(valueOf('Copper finish')).toBe('none specified');

    render({ ...GLASGOW, copperFinish: 'ENIG' });
    expect(valueOf('Copper finish')).toBe('ENIG');

    // Absent is a DIFFERENT fact from "the finish is none", and reads as a dash.
    render(BARE);
    expect(valueOf('Copper finish')).toBe('—');
  });

  it('dashes a listed thickness the file never carried rather than printing a zero', () => {
    render(BARE);
    expect(valueOf('Listed thickness')).toBe('—');
    expect(valueOf('Total layers')).toBe('4');
  });

  it('counts the via groups the file carries', () => {
    render(GLASGOW);
    expect(valueOf('Thru vias')).toBe('416');
    expect(valueOf('Blind/Buried vias')).toBe('0');
    expect(valueOf('Micro vias')).toBe('0');
    // Only stated when there is one to state.
    expect(summaryPairs().map((p) => p[0])).not.toContain('Unknown via type');
    render({ ...GLASGOW, vias: [...GLASGOW.vias, { type: 'unknown', start: 'F.Cu', end: 'B.Cu', count: 3 }] });
    expect(valueOf('Unknown via type')).toBe('3');
  });
});

describe('the copper-kind buckets', () => {
  it('names every non-zero bucket and stays silent about the empty ones', () => {
    render(GLASGOW);
    const labels = summaryPairs().map((p) => p[0]);
    expect(labels).toContain('Signal');
    expect(labels).toContain('Plane');
    expect(labels).not.toContain('Mixed');
    expect(labels).not.toContain('Jumper');
    expect(labels).not.toContain('Other');
    expect(valueOf('Signal')).toBe('2');
    expect(valueOf('Plane')).toBe('2');
  });

  it('accounts for a layer kind it cannot name, so the buckets always add up to the total', () => {
    // The hole this closes: a 4-layer board with one Mixed and one kind the
    // reader has no mapping for used to read "4 layers · 2 signal", leaving two
    // layers unexplained on the panel whose whole thesis is that it only
    // states what the file says.
    render({
      ...GLASGOW,
      copperLayers: [
        { ordinal: 1, name: 'F.Cu', kind: 'Signal' },
        { ordinal: 2, name: 'In1.Cu', kind: 'Mixed' },
        { ordinal: 3, name: 'In2.Cu', kind: 'user_defined' },
        { ordinal: 4, name: 'B.Cu', kind: 'Signal' },
      ],
    });
    expect(valueOf('Signal')).toBe('2');
    expect(valueOf('Mixed')).toBe('1');
    expect(valueOf('Other')).toBe('1');
    const buckets = ['Signal', 'Plane', 'Mixed', 'Jumper', 'Other']
      .map((l) => Number(valueOf(l) ?? 0))
      .reduce((a, b) => a + b, 0);
    expect(buckets).toBe(Number(valueOf('Total layers')));
    // …and it says what "Other" means rather than leaving a bare number.
    expect(text()).toMatch(/Other counts copper layers/);
  });
});

describe('a board saved without Board Setup', () => {
  it('says so, and still shows the copper rows and via counts it can derive', () => {
    render(BARE);
    expect(text()).toMatch(/No Board Setup saved/);
    expect(text()).toMatch(/Board Setup → Physical Stackup in KiCad/);
    // The rows it CAN carry: the four copper layers, thickness unknown.
    const cells = [...container.querySelectorAll('tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    );
    expect(cells).toEqual([
      ['1', 'F.Cu', 'Signal', '—'],
      ['2', 'In1.Cu', 'Plane', '—'],
      ['3', 'In2.Cu', 'Plane', '—'],
      ['4', 'B.Cu', 'Signal', '—'],
    ]);
    expect(valueOf('Thru vias')).toBe('416');
    expect(text().toLowerCase()).not.toContain('upload');
  });

  it('never claims equal bands are drawn to scale', () => {
    render(GLASGOW);
    expect(text()).toMatch(/Drawn to scale/);
    expect(text()).not.toMatch(/Equal bands/);

    render(BARE);
    expect(text()).toMatch(/Equal bands/);
    expect(text()).not.toMatch(/Drawn to scale/);

    // The subtle one: a stackup block IS present, but not one row in it carries
    // a thickness — so `bands` weighs them equally and the caption must too.
    render({ ...GLASGOW, stackup: GLASGOW_ROWS.map((r) => ({ ...r, thicknessMm: null })), listedThicknessMm: null });
    expect(text()).toMatch(/Equal bands/);
    expect(text()).not.toMatch(/Drawn to scale/);
  });

  it('says a board whose layer list could not be read has no copper layers', () => {
    render({ ...BARE, copperLayers: [], layerCount: 0, vias: [] });
    expect(text()).toMatch(/lists no copper layers/);
    expect(container.querySelector('tbody')).toBeNull();
  });
});

describe('the cross-section', () => {
  it('draws every physical row, whether or not that row gets a label', () => {
    render(GLASGOW);
    expect(container.querySelectorAll('svg rect')).toHaveLength(GLASGOW_ROWS.length);
  });

  it('labels the stack anatomy and drops only the labels that would collide', () => {
    // Glasgow's three ~67-unit dielectrics sit beside eight rows of 1-7 units,
    // so silk, paste and mask at each face land within a few units of the
    // copper foil. Labelling all thirteen renders a smear; these seven are
    // legible and the table carries the rest.
    render(GLASGOW);
    expect(labelTexts()).toEqual([
      'F.Cu',
      'dielectric 1',
      'In1.Cu',
      'dielectric 2',
      'In2.Cu',
      'dielectric 3',
      'B.Cu',
    ]);
    expect(text()).toMatch(/Every row is named in the table/);
  });

  it('keeps every placed label clear of its neighbours by at least the line height', () => {
    render(GLASGOW);
    const placed = [...container.querySelectorAll('svg text')].map((t) => Number(t.getAttribute('y')));
    expect(placed.length).toBeGreaterThan(1);
    // Labels come out in file order, so consecutive gaps are the tightest ones.
    const gaps = placed.slice(1).map((y, i) => y - (placed[i] ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(fontSizeOfLabel());
  });

  it('offers copper a label first, so a dense stack never labels trim over a foil', () => {
    // Directly, because happy-dom has no layout to measure it through: a thin
    // copper foil pinched between two rows of trim keeps its label and they
    // lose theirs, whatever their order in the file.
    const drawn = [
      { name: 'F.SilkS', kind: 'other' as const, y: 0, h: 2 },
      { name: 'F.Mask', kind: 'mask' as const, y: 2, h: 2 },
      { name: 'F.Cu', kind: 'copper' as const, y: 4, h: 2 },
      { name: 'dielectric 1', kind: 'dielectric' as const, y: 6, h: 100 },
    ];
    expect(labelledBands(drawn, 12).map((b) => b.name)).toEqual(['F.Cu', 'dielectric 1']);
  });

  it('runs the via barrel between the real layers it connects, inside the board', () => {
    render(GLASGOW);
    const lanes = barrels();
    expect(lanes).toHaveLength(1);
    const lane = lanes[0]!;
    const x = Number(lane.getAttribute('x1'));
    // Inside the board's own width, never out over the label gutter.
    const board = container.querySelector('svg rect')!;
    expect(x).toBeGreaterThanOrEqual(boardLeft());
    expect(x).toBeLessThanOrEqual(boardLeft() + Number(board.getAttribute('width')));
    // A through via spans the stack: from the top copper band to the bottom one.
    expect(Number(lane.getAttribute('y2')) - Number(lane.getAttribute('y1'))).toBeGreaterThan(200);
    expect(container.querySelector('svg title')?.textContent).toBe('416 through vias');
  });

  it('says how many via groups it had no room to draw rather than dropping them in silence', () => {
    const many = Array.from({ length: 12 }, () => ({ type: 'blind' as const, start: 'F.Cu', end: 'In1.Cu', count: 2 }));
    render({ ...GLASGOW, vias: many });
    const lanes = barrels();
    expect(lanes).toHaveLength(8);
    for (const lane of lanes) expect(Number(lane.getAttribute('x1'))).toBeGreaterThanOrEqual(boardLeft());
    expect(text()).toMatch(/4 more via groups are counted here but left out of the figure, which has room for 8/);
    // The COUNT is still whole — only the figure is abridged.
    expect(valueOf('Blind\/Buried vias')).toBe('24');
  });

  it('grows the drawing box rather than drawing rows outside it', () => {
    // A stack with more rows than 240 units can floor. `bands` keeps the floors
    // and overflows; in an svg that overflow is clipped away invisibly, so the
    // box has to be the one that moves.
    const tall = Array.from({ length: 200 }, (_, i) => row(`layer ${i}`, 'core', 0.1));
    const s: BoardStackup = { ...GLASGOW, stackup: tall };
    expect(minHeightPx(s)).toBe(400);
    render(s);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 260 400');

    // …and a normal board is untouched by the clamp.
    render(GLASGOW);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toBe('0 0 260 240');
  });
});

// The class names above are echoed back by vitest's CSS-off module proxy, so
// they prove nothing about the stylesheet. These two read the SOURCE.
function scss(): string {
  return readFileSync(join(__dirname, 'StackupPanel.module.scss'), 'utf8');
}

function ruleBody(selector: string): string {
  const source = scss();
  const start = source.indexOf(`\n${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n}', start));
}

function fontSizeOfLabel(): number {
  const match = /font-size:\s*(\d+(?:\.\d+)?)px/.exec(ruleBody('.label'));
  expect(match).not.toBeNull();
  return Number(match![1]);
}

describe('the stylesheet the figure depends on', () => {
  it('gives every band kind a fill, so a band can never render invisible', () => {
    // The component reaches these through an exhaustive Record<BandKind,…>, so
    // a NEW kind is a type error — but a kind whose rule was deleted here would
    // paint nothing at all and no DOM assertion could see it.
    for (const selector of ['.bandCopper', '.bandDielectric', '.bandMask', '.bandOther']) {
      expect(ruleBody(selector)).toMatch(/fill:\s*#[0-9a-f]{3,8}/i);
    }
  });

  it('keeps the label font smaller than the gap the placement reserves for it', () => {
    // The two halves of one measurement living in two files: `.label`'s
    // font-size here, LABEL_GAP in the component. A font raised past the gap
    // would put overlapping text back on the figure with every test still green.
    const tsx = readFileSync(join(__dirname, 'StackupPanel.tsx'), 'utf8');
    const gap = /const LABEL_GAP = (\d+)/.exec(tsx);
    expect(gap).not.toBeNull();
    expect(fontSizeOfLabel()).toBeLessThan(Number(gap![1]));
  });
});
