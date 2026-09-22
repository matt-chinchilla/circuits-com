// @vitest-environment happy-dom
/**
 * The Board panel on its own: the tab strip, the Layers and Objects tabs, and
 * the Nets list, driven through a tiny host that holds the page's
 * `BoardViewState` the way the viewer does. The page-level contract (the
 * state reaching the 2D board and the 3D view) is in viewerPage.test.ts.
 *
 * No JSX (a `*.test.ts`), no testing library: createRoot + act.
 */
import { act, createElement, createRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NetInfo } from '@public/components/kicad/canvasController';
import { EMPTY_BOARD_VIEW, type BoardViewState, type PanelLayer } from '../boardView';
import type { PartFacts } from '../partFacts';
import BoardPanel, { SHEET_QUERY, type BoardPanelHandle } from './BoardPanel';
import { NET_ROWS } from './BoardControls';
import type { BoardContext } from './BoardControls';

vi.mock('react-router-dom', () => ({
  Link: (props: Record<string, unknown>) => createElement('a', { href: props.to as string }, props.children as never),
}));

const LAYERS: PanelLayer[] = [
  { name: 'F.Cu', kind: 'copper', side: 'F', color: 'rgba(200, 52, 52, 1)' },
  { name: 'In1.Cu', kind: 'copper', side: 'In', color: 'rgba(127, 200, 127, 1)' },
  { name: 'B.Cu', kind: 'copper', side: 'B', color: 'rgba(77, 127, 196, 1)' },
  { name: 'F.SilkS', kind: 'silk', side: 'F', color: 'rgba(242, 237, 161, 1)' },
  { name: 'Edge.Cuts', kind: 'edge', side: null, color: 'rgba(208, 210, 205, 1)' },
];
const NETS: NetInfo[] = [
  { number: 1, name: 'GND' },
  { number: 2, name: '/SDA' },
  { number: 3, name: '' },
];

let container: HTMLDivElement;
let root: Root;
/** The state the host holds, read back by the tests. */
let state: BoardViewState;
const handle = createRef<BoardPanelHandle>();

interface HostProps {
  context: BoardContext | null;
  facts?: PartFacts | null;
  nets?: NetInfo[];
  board?: boolean;
}

function Host({ context, facts = null, nets = NETS, board = true }: HostProps) {
  const [view, setView] = useState<BoardViewState>(EMPTY_BOARD_VIEW);
  state = view;
  return createElement(BoardPanel, {
    ref: handle,
    facts,
    knownRefs: ['U1'],
    views: { schematic: true, board: true, board3d: true },
    current: context,
    onSearch: () => {},
    onClear: () => {},
    onShow: () => {},
    onPriceBom: () => {},
    board: board
      ? { context, hint: 'Open the Board or 3D tab', layers: LAYERS, nets, view, onChange: setView }
      : null,
  });
}

async function render(props: HostProps) {
  await act(async () => {
    root.render(createElement(Host, props));
  });
}

async function click(el: Element | null) {
  if (el == null) throw new Error('nothing to click');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function key(el: Element, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

async function setRange(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function typeInto(input: HTMLInputElement, value: string) {
  await setRange(input, value);
}

const tab = (label: string) =>
  [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === label) as HTMLButtonElement;
const box = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement | undefined;

beforeEach(() => {
  // The dock is remembered per browser; every test starts from the default.
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the tab strip', () => {
  it('has no tabs without a board', async () => {
    await render({ context: null, board: false });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('aside')?.getAttribute('aria-label')).toBe('Part');
  });

  it('is one tab stop; the arrows and Home/End move focus and selection', async () => {
    await render({ context: 'board' });
    const list = container.querySelector('[role="tablist"]')!;
    expect(tab('Parts').tabIndex).toBe(0);
    expect(tab('Layers').tabIndex).toBe(-1);
    await key(tab('Parts'), 'ArrowRight');
    expect(tab('Layers').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('Layers'));
    await key(list, 'End');
    expect(tab('Objects').getAttribute('aria-selected')).toBe('true');
    await key(list, 'ArrowRight');
    expect(tab('Parts').getAttribute('aria-selected')).toBe('true');
    await key(list, 'ArrowLeft');
    expect(tab('Objects').getAttribute('aria-selected')).toBe('true');
    // Each selected tab names the panel it opens, and the panel names it back.
    const panel = document.getElementById(tab('Objects').getAttribute('aria-controls')!)!;
    expect(panel.getAttribute('aria-labelledby')).toBe(tab('Objects').id);
  });

  it('skips the disabled tabs, and a disabled tab that was open says why', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    await render({ context: null });
    expect(tab('Layers').getAttribute('aria-disabled')).toBe('true');
    expect(container.textContent).toMatch(/Open the Board or 3D tab/);
    await key(tab('Layers'), 'ArrowRight');
    // Only Parts is usable.
    expect(tab('Parts').getAttribute('aria-selected')).toBe('true');
    await click(tab('Objects'));
    expect(tab('Parts').getAttribute('aria-selected')).toBe('true');
  });

  it('"/" (the page’s focusSearch) goes to the Parts tab to find its field', async () => {
    await render({ context: 'board' });
    await click(tab('Objects'));
    await act(async () => handle.current?.focusSearch());
    expect(tab('Parts').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(box('Find a reference'));
  });

  it('a part picked elsewhere brings the Parts tab forward', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    const facts = { ref: 'U1', found: false } as PartFacts;
    await render({ context: 'board', facts });
    expect(tab('Parts').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('aside p')?.textContent).toBe('U1');
  });
});

describe('Layers', () => {
  it('lists every layer with its swatch, a visibility box and its name', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    // The layer rows sit under their group rows: copper, then silk, then
    // mechanical, in the order the layers arrived within each.
    const rows = [...container.querySelectorAll('ul[aria-label="Layers"] ul li')];
    expect(rows.map((r) => r.querySelector('button')?.textContent)).toEqual(LAYERS.map((l) => l.name));
    expect((rows[0].querySelector('span[aria-hidden]') as HTMLElement).style.background).toContain('200');
    await click(box('Show B.Cu'));
    expect([...state.hiddenLayers]).toEqual(['B.Cu']);
    expect(box('Show B.Cu').checked).toBe(false);
  });

  it('a name lights the layer; again clears it', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    await click(button('F.Cu')!);
    expect(state.highlightedLayer).toBe('F.Cu');
    expect(button('F.Cu')!.getAttribute('aria-pressed')).toBe('true');
    await click(button('F.Cu')!);
    expect(state.highlightedLayer).toBeNull();
  });

  it('hides all and shows all', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    await click(button('Hide all')!);
    expect(state.hiddenLayers.size).toBe(LAYERS.length);
    await click(button('Show all')!);
    expect(state.hiddenLayers.size).toBe(0);
  });

  it('on the 3D tab, a layer the 3D view does not draw cannot be toggled and says so', async () => {
    await render({ context: 'board3d' });
    await click(tab('Layers'));
    expect(box('Show In1.Cu').disabled).toBe(true);
    expect(box('Show Edge.Cuts').disabled).toBe(true);
    expect(box('Show F.Cu').disabled).toBe(false);
    expect(container.textContent).toMatch(/not in 3D/);
  });
});

describe('Objects', () => {
  const rangeFor = (label: string) => {
    const lab = [...container.querySelectorAll('label')].find((l) => l.textContent === label) as HTMLLabelElement;
    return document.getElementById(lab.htmlFor) as HTMLInputElement;
  };

  it('a labelled slider sets the class’s opacity; the box hides it and restores it', async () => {
    await render({ context: 'board' });
    await click(tab('Objects'));
    await setRange(rangeFor('Zones'), '40');
    expect(state.opacity.zones).toBe(0.4);
    expect(rangeFor('Zones').getAttribute('aria-valuetext')).toBe('40%');
    await click(box('Show zones'));
    expect(state.opacity.zones).toBe(0);
    await click(box('Show zones'));
    expect(state.opacity.zones).toBe(0.4);
    await setRange(rangeFor('Zones'), '100');
    expect(state.opacity.zones).toBeUndefined();
  });

  it('draws a glyph before every class name, in the row’s own ink', async () => {
    await render({ context: 'board' });
    await click(tab('Objects'));
    const rows = [...container.querySelectorAll('ul[aria-label="Objects"] li')];
    expect(rows.length).toBe(7);
    for (const row of rows) {
      const svg = row.querySelector('svg[data-glyph]')!;
      expect(svg).not.toBeNull();
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      // The glyph comes BEFORE the name, as Altium lists them.
      const label = row.querySelector('label[for]')!;
      expect(svg.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(rows.map((r) => r.querySelector('svg')?.getAttribute('data-glyph'))).toEqual(['tracks', 'vias', 'pads', 'holes', 'zones', 'grid', 'page']);
  });

  it('shows the 2D classes on the Board tab and the 3D classes on the 3D tab', async () => {
    await render({ context: 'board' });
    await click(tab('Objects'));
    expect(rangeFor('Grid')).not.toBeNull();
    expect(rangeFor('Through-holes')).not.toBeNull();
    await render({ context: 'board3d' });
    expect(rangeFor('Bodies')).not.toBeNull();
    expect([...container.querySelectorAll('label')].some((l) => l.textContent === 'Grid')).toBe(false);
  });
});

describe('Nets', () => {
  it('searches by name or number, lights a net on click and clears it on a second', async () => {
    await render({ context: 'board' });
    await click(tab('Objects'));
    const list = () => [...container.querySelectorAll('ul[aria-label="Nets"] button')].map((b) => b.textContent);
    expect(list()).toEqual(['GND', '/SDA', 'Net 3']);
    await typeInto(box('Find a net'), 'sd');
    expect(list()).toEqual(['/SDA']);
    await typeInto(box('Find a net'), '3');
    expect(list()).toEqual(['Net 3']);
    await typeInto(box('Find a net'), 'nothing');
    expect(container.textContent).toMatch(/No net matches/);
    await typeInto(box('Find a net'), '');
    await click(button('GND')!);
    expect(state.highlightedNet).toBe(1);
    await click([...container.querySelectorAll('ul[aria-label="Nets"] button')][0]);
    expect(state.highlightedNet).toBeNull();
  });

  it('draws at most NET_ROWS rows and says how to reach the rest', async () => {
    const many = Array.from({ length: NET_ROWS + 50 }, (_, i) => ({ number: i + 1, name: `N${i + 1}` }));
    await render({ context: 'board', nets: many });
    await click(tab('Objects'));
    expect(container.querySelectorAll('ul[aria-label="Nets"] li').length).toBe(NET_ROWS);
    expect(container.textContent).toMatch(new RegExp(`Showing ${NET_ROWS} of 250`));
  });
});

// The rail and the drawer (owner, 2026-09-22): the icon tabs ARE the toggle,
// the dock is remembered, and a part picked elsewhere opens the drawer.
describe('the rail and the dock', () => {
  const aside = () => container.querySelector('aside') as HTMLElement;
  const docked = () => aside().dataset.docked !== undefined;
  const sheetOpen = () => aside().dataset.open !== undefined;
  /** Which shape the panel believes it has. happy-dom's window is 1024 wide —
   *  the sheet's own breakpoint — and its media queries do not follow a width
   *  set from a test, so the query is answered here outright. */
  const atPhone = (phone: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      value: (media: string) => ({ media, matches: phone && media === SHEET_QUERY, addEventListener() {}, removeEventListener() {} }),
      configurable: true,
      writable: true,
    });
  };
  beforeEach(() => atPhone(false));

  it('opens on Parts, closes on the lit tab or the ×, and reopens on any tab', async () => {
    await render({ context: 'board' });
    expect(docked()).toBe(true);
    expect(tab('Parts').getAttribute('aria-expanded')).toBe('true');
    expect(tab('Layers').getAttribute('aria-expanded')).toBe('false');
    // The lit tab again folds the drawer away; the selection stays.
    await click(tab('Parts'));
    expect(docked()).toBe(false);
    expect(tab('Parts').getAttribute('aria-selected')).toBe('true');
    expect(tab('Parts').getAttribute('aria-expanded')).toBe('false');
    // Any tab opens it again, on that tab.
    await click(tab('Layers'));
    expect(docked()).toBe(true);
    expect(tab('Layers').getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('ul[aria-label="Layers"]')).not.toBeNull();
    // The × in the drawer's head closes it and hands focus back to the rail.
    await click(container.querySelector('button[aria-label="Close panel"]'));
    expect(docked()).toBe(false);
    expect(document.activeElement).toBe(tab('Layers'));
  });

  it('remembers the dock per browser, and reads it back on the next mount', async () => {
    await render({ context: 'board' });
    await click(tab('Objects'));
    expect(JSON.parse(localStorage.getItem('cc.viewer.panel') ?? 'null')).toEqual({ tab: 'objects', docked: true });
    await click(tab('Objects'));
    expect(JSON.parse(localStorage.getItem('cc.viewer.panel') ?? 'null')).toEqual({ tab: 'objects', docked: false });
    await act(async () => root.unmount());
    root = createRoot(container);
    await render({ context: 'board' });
    expect(docked()).toBe(false);
    expect(tab('Objects').getAttribute('aria-selected')).toBe('true');
  });

  it('a part picked elsewhere opens a closed drawer on Parts', async () => {
    await render({ context: 'board' });
    await click(tab('Parts'));
    expect(docked()).toBe(false);
    await render({ context: 'board', facts: { ref: 'U1', found: false } as PartFacts });
    expect(docked()).toBe(true);
    expect(tab('Parts').getAttribute('aria-expanded')).toBe('true');
  });

  it('draws each rail tab as a glyph with its name for the reader, and a title for the pointer', async () => {
    await render({ context: 'board' });
    for (const label of ['Parts', 'Layers', 'Objects']) {
      const t = tab(label);
      expect(t.querySelector('i.ph-light')).not.toBeNull();
      expect(t.textContent).toBe(label);
      expect(t.title).toBe(label);
    }
    // Disabled tabs carry the reason as their title instead.
    await render({ context: null });
    expect(tab('Layers').title).toBe('Open the Board or 3D tab');
  });

  it('moves along the rail with Up and Down as well as Left and Right', async () => {
    await render({ context: 'board' });
    await key(tab('Parts'), 'ArrowDown');
    expect(tab('Layers').getAttribute('aria-selected')).toBe('true');
    await key(tab('Layers'), 'ArrowUp');
    expect(tab('Parts').getAttribute('aria-selected')).toBe('true');
  });

  it('on a phone the lit tab toggles the SHEET, and leaves the dock alone', async () => {
    atPhone(true);
    await render({ context: 'board' });
    expect(sheetOpen()).toBe(false);
    // Closed sheet, lit tab: a tap opens the sheet (it must never be a no-op).
    await click(tab('Parts'));
    expect(sheetOpen()).toBe(true);
    expect(docked()).toBe(true);
    // Open sheet, lit tab: a tap closes the sheet; the dock is untouched.
    await click(tab('Parts'));
    expect(sheetOpen()).toBe(false);
    expect(docked()).toBe(true);
    // Another tab opens the sheet on that tab.
    await click(tab('Layers'));
    expect(sheetOpen()).toBe(true);
    expect(tab('Layers').getAttribute('aria-selected')).toBe('true');
  });

  it('without a board the rail is one toggle for the part panel, not a tablist', async () => {
    await render({ context: null, board: false });
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    const toggle = aside().querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(toggle.textContent).toBe('Part');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await click(toggle);
    expect(docked()).toBe(false);
  });
});

// The Layers tab as a tree (owner, 2026-09-22): six groups in a fixed order,
// a tri-state box per group, a fold per group, and a Top / Bottom / Both
// filter that scopes the bulk actions to what is listed.
describe('the layer tree', () => {
  const groupRows = () => [...container.querySelectorAll('ul[aria-label="Layers"] > li')];
  const groupToggle = (label: string) =>
    [...container.querySelectorAll('button[aria-expanded]')].find((b) => b.textContent?.startsWith(label)) as HTMLButtonElement;
  const groupBox = (label: string) => box(`Show all ${label.toLowerCase()} layers`);
  const layerNames = () => [...container.querySelectorAll('ul[aria-label="Layers"] ul li button')].map((b) => b.textContent);

  it('groups the layers under Copper, Silkscreen and Mechanical with a count on each', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    expect(groupRows().map((li) => li.querySelector('button')?.textContent)).toEqual(['Copper3', 'Silkscreen1', 'Mechanical1']);
    expect(layerNames()).toEqual(['F.Cu', 'In1.Cu', 'B.Cu', 'F.SilkS', 'Edge.Cuts']);
    // Every group starts open.
    expect(groupToggle('Copper').getAttribute('aria-expanded')).toBe('true');
  });

  it('a group box shows or hides the whole group, and reads all / some / none', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    expect(groupBox('Copper').checked).toBe(true);
    expect(groupBox('Copper').indeterminate).toBe(false);
    await click(box('Show In1.Cu'));
    expect(groupBox('Copper').checked).toBe(true);
    expect(groupBox('Copper').indeterminate).toBe(true);
    // Some shown: the box's click SHOWS the rest.
    await click(groupBox('Copper'));
    expect(state.hiddenLayers.size).toBe(0);
    // All shown: the box's click hides them all.
    await click(groupBox('Copper'));
    expect([...state.hiddenLayers].sort()).toEqual(['B.Cu', 'F.Cu', 'In1.Cu']);
    expect(groupBox('Copper').checked).toBe(false);
    expect(groupBox('Copper').indeterminate).toBe(false);
    // …and the other groups are untouched.
    expect(groupBox('Silkscreen').checked).toBe(true);
  });

  it('folds a group shut and open again, keeping its layers’ state', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    await click(box('Show F.Cu'));
    await click(groupToggle('Copper'));
    expect(groupToggle('Copper').getAttribute('aria-expanded')).toBe('false');
    expect(layerNames()).toEqual(['F.SilkS', 'Edge.Cuts']);
    // The fold survives a trip to another tab and back.
    await click(tab('Objects'));
    await click(tab('Layers'));
    expect(groupToggle('Copper').getAttribute('aria-expanded')).toBe('false');
    await click(groupToggle('Copper'));
    expect(layerNames()).toEqual(['F.Cu', 'In1.Cu', 'B.Cu', 'F.SilkS', 'Edge.Cuts']);
    expect(box('Show F.Cu').checked).toBe(false);
  });

  it('Top / Bottom / Both list one face, and the bulk actions act on what is listed', async () => {
    await render({ context: 'board' });
    await click(tab('Layers'));
    const side = (label: string) => [...container.querySelectorAll('[aria-label="Side"] button')].find((b) => b.textContent === label) as HTMLButtonElement;
    expect(side('Both').getAttribute('aria-pressed')).toBe('true');
    await click(side('Top'));
    // Front layers and the board-wide Edge.Cuts; no inner or back copper.
    expect(layerNames()).toEqual(['F.Cu', 'F.SilkS', 'Edge.Cuts']);
    expect(groupRows().map((li) => li.querySelector('button')?.textContent)).toEqual(['Copper1', 'Silkscreen1', 'Mechanical1']);
    await click(button('Hide all')!);
    expect([...state.hiddenLayers].sort()).toEqual(['Edge.Cuts', 'F.Cu', 'F.SilkS']);
    await click(side('Bottom'));
    expect(layerNames()).toEqual(['B.Cu', 'Edge.Cuts']);
    expect(box('Show B.Cu').checked).toBe(true);
    // "Show all" on the Bottom view shows Edge.Cuts again and leaves the
    // hidden front layers alone.
    await click(button('Show all')!);
    expect([...state.hiddenLayers].sort()).toEqual(['F.Cu', 'F.SilkS']);
    // The choice survives a trip to Objects and back.
    await click(tab('Objects'));
    await click(tab('Layers'));
    expect(side('Bottom').getAttribute('aria-pressed')).toBe('true');
  });
});
