// @vitest-environment happy-dom
/**
 * The /viewer page's wiring, for the parts a playtest cannot check cheaply or
 * reproducibly: that the BOM is priced exactly ONCE per project, that a #ref
 * arriving after mount still focuses, that the page and the renderer name the
 * same sheet when a designator is focused, and that a sheet the renderer had to
 * drop says so instead of doing nothing.
 *
 * No JSX: this is a `*.test.ts` (the only shape vitest discovers here, and the
 * shape `tsc -b`/eslint exclude), so elements are built with createElement.
 * There is no testing-library — createRoot + act, as DesignCanvas.test.ts does.
 *
 * The unrenderable-sheet set is DRIVEN through the DesignCanvas stub's
 * `onUnrenderableSheets` callback rather than computed here. That is the whole
 * point of the seam: the page holds no opinion about which renderer drops what,
 * so these tests state the renderer's answer and assert what the page does with
 * it. The KiCanvas rule itself is pinned in `kicanvasController.test.ts`, and
 * that the callback carries the controller's answer in `DesignCanvas.test.ts`.
 */
import { act, createElement, forwardRef, Profiler, useEffect, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AnyProps = Record<string, never> & Record<string, unknown>;

let hash = '';
let session: unknown = null;
/** What the intake's drop opens next. */
let reopen: () => unknown = () => makeSession();

/** What the canvas host was last rendered with, and the handle it exposes.
 *  `unrenderable` is what the stubbed renderer reports at mount. */
const canvas = {
  view: '' as string,
  activeSheet: undefined as string | undefined,
  onState: null as ((s: string) => void) | null,
  unrenderable: [] as string[],
  /** How many times the host has MOUNTED. The Phase 2 invariant is one embed
   *  per project, so every tab trip has to leave this alone. */
  mounts: 0,
  focusRef: vi.fn(async (_ref: string, _sheet?: string, _view?: string) => 'focused' as const),
  selectRef: vi.fn(async (_ref: string | null, _sheet?: string, _view?: string) => 'focused' as const),
  /** The page's `onSelection` handler, so a test can play a click on the drawing. */
  onSelection: null as ((s: { ref: string | null; sheet?: string; view?: string }) => void) | null,
  /** The page's `onLayers` handler, so a test can play the board's `layers` event. */
  onLayers: null as ((layers: FakeLayer[]) => void) | null,
  /** What the page told the canvas to take fullscreen. */
  fullscreenTarget: null as (() => HTMLElement | null) | null,
  /** The board as the fake renderer holds it: [] while no board is on screen. */
  board: [] as FakeLayer[],
  nets: [] as { number: number; name: string }[],
  setLayerVisible: vi.fn((name: string, visible: boolean) => {
    const layer = canvas.board.find((l) => l.name === name);
    if (layer != null) layer.visible = visible;
  }),
  highlightLayer: vi.fn((name: string | null) => {
    for (const l of canvas.board) l.highlighted = l.name === name;
  }),
  setObjectOpacity: vi.fn(),
  highlightNet: vi.fn(),
};

interface FakeLayer { name: string; kind: string; side: string | null; color: string; visible: boolean; highlighted: boolean }

/** Every (parsed, viewerHref) pair the page has handed the workbench, in order
 *  — the record that proves "one match per project". */
const wbCalls: { parsed: unknown; viewerHref: unknown }[] = [];
const wb = {
  rows: [] as unknown[],
  matching: false,
  matchError: null as string | null,
  resolveNote: null as string | null,
  resolveError: null as string | null,
  buildQty: 1,
  setBuildQty: vi.fn(),
  includeDnp: false,
  setIncludeDnp: vi.fn(),
  pickSimilar: vi.fn(),
  reset: vi.fn(),
};

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/viewer', search: '', hash, state: null, key: 'k' }),
  // The part panel links to the part page; a plain anchor stands in for the router's.
  Link: (props: AnyProps) => createElement('a', { href: props.to as string, className: props.className as string }, props.children as never),
}));
vi.mock('framer-motion', () => ({
  motion: { div: (props: AnyProps) => createElement('div', null, props.children as never) },
}));
vi.mock('@public/components/PageHead', () => ({ default: () => null }));
vi.mock('@public/components/layout/PageHeaderBand', () => ({ default: () => null }));
vi.mock('./components/ViewerIntake', () => ({
  default: (props: AnyProps) =>
    createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'intake',
        onClick: () => (props.onProject as (p: unknown) => void)({}),
      },
      'drop',
    ),
}));
vi.mock('@public/components/kicad/DesignCanvas', () => ({
  default: forwardRef(function CanvasStub(props: AnyProps, ref: never) {
    canvas.view = props.view as string;
    canvas.activeSheet = props.activeSheet as string | undefined;
    canvas.onState = props.onState as (s: string) => void;
    canvas.onSelection = props.onSelection as typeof canvas.onSelection;
    canvas.onLayers = props.onLayers as typeof canvas.onLayers;
    canvas.fullscreenTarget = props.fullscreenTarget as typeof canvas.fullscreenTarget;
    useImperativeHandle(ref, () => ({
      focusRef: canvas.focusRef,
      selectRef: canvas.selectRef,
      zoom: async () => true,
      hasBoardControls: () => true,
      layers: () => canvas.board.map((l) => ({ ...l })),
      setLayerVisible: canvas.setLayerVisible,
      highlightLayer: canvas.highlightLayer,
      setObjectOpacity: canvas.setObjectOpacity,
      nets: () => canvas.nets,
      highlightNet: canvas.highlightNet,
    }), []);
    // The real host reports in its MOUNT effect, before the renderer bundle is
    // fetched — an effect here, not a render-body call, for the same reason:
    // it is a parent setState.
    const report = props.onUnrenderableSheets as ((paths: string[]) => void) | undefined;
    useEffect(() => {
      report?.(canvas.unrenderable);
    }, [report]);
    useEffect(() => {
      canvas.mounts += 1;
    }, []);
    return createElement('div', { 'data-testid': 'canvas' });
  }),
}));
/** The 3D host, stubbed for the same reason the canvas is: the contract this
 *  file tests is WHEN the page mounts it, not what three.js draws. */
/** What the 3D host was last rendered with — the Board panel state rides its props. */
const board3d = { props: null as AnyProps | null };
vi.mock('@public/components/kicad/board3d/Board3DView', () => ({
  default: (props: AnyProps) =>
    (board3d.props = props) && createElement(
      'div',
      { 'data-testid': 'board3d', 'data-selected': (props.selectedRef as string | null) ?? '' },
      // A stand-in for a pick on the 3D board.
      createElement('button', { type: 'button', 'data-testid': 'pick3d', onClick: () => (props.onSelect as (r: string | null) => void)('U2') }, 'pick'),
    ),
}));
/** What the BOM table stub was last rendered with. */
const bomTable = { props: null as AnyProps | null };
vi.mock('@public/components/bom/BomTable', () => ({
  default: (props: AnyProps) => {
    bomTable.props = props;
    return createElement(
      'div',
      { 'data-testid': 'bom-ref', 'data-selected': (props.selectedRef as string | null) ?? '' },
      ['U1', 'U2'].map((ref) =>
        createElement(
          'button',
          {
            key: ref,
            type: 'button',
            'data-ref': ref,
            onClick: () => (props.onRefClick as (r: string) => void)(ref),
          },
          ref,
        ),
      ),
    );
  },
}));
vi.mock('@public/components/bom/ShareBar', () => ({
  default: () => createElement('div', { 'data-testid': 'sharebar' }),
}));
vi.mock('@public/services/bom/useBomWorkbench', () => ({
  useBomWorkbench: (parsed: unknown, viewerHref: unknown) => {
    wbCalls.push({ parsed, viewerHref });
    return wb;
  },
}));
/**
 * The REAL reader, wrapped so the page's parses can be counted. Not a stub: the
 * stackup tests below read a real board through this, and the contract the
 * counter exists for is WHEN the page parses, not what it gets back.
 */
const readStackupCalls = vi.fn();
vi.mock('@public/services/kicad/boardStackup', async () => {
  const actual =
    await vi.importActual<typeof import('@public/services/kicad/boardStackup')>(
      '@public/services/kicad/boardStackup',
    );
  return {
    ...actual,
    readStackup: (boardText: string) => {
      readStackupCalls(boardText);
      return actual.readStackup(boardText);
    },
  };
});
/** The same wrapper around the thumbnail reader: WHEN the sheets are drawn. */
const readSheetThumbnailCalls = vi.fn();
vi.mock('@public/services/kicad/sheetThumbnail', async () => {
  const actual =
    await vi.importActual<typeof import('@public/services/kicad/sheetThumbnail')>(
      '@public/services/kicad/sheetThumbnail',
    );
  return {
    ...actual,
    readSheetThumbnail: (text: string) => {
      readSheetThumbnailCalls(text);
      return actual.readSheetThumbnail(text);
    },
  };
});
/** The same wrapper around the placement reader: WHEN the board is scanned. */
const readPlacementsCalls = vi.fn();
vi.mock('@public/services/kicad/boardPlacements', async () => {
  const actual =
    await vi.importActual<typeof import('@public/services/kicad/boardPlacements')>(
      '@public/services/kicad/boardPlacements',
    );
  return {
    ...actual,
    readPlacements: (boardText: string) => {
      readPlacementsCalls(boardText);
      return actual.readPlacements(boardText);
    },
  };
});
vi.mock('@public/services/designSession', () => ({
  getDesignSession: () => session,
  clearDesignSession: () => {
    session = null;
  },
  openDesign: () => {
    session = reopen();
    return session;
  },
}));

const { default: ViewerPage } = await import('./index');

/**
 * A small but REAL `.kicad_pcb`: two copper layers, a three-row physical
 * stackup and one through via. `readStackup` is deliberately NOT mocked in this
 * file — the contract under test is what the page does with a reader that can
 * throw, so it is fed real text and left to answer.
 */
const BOARD_TEXT = `(kicad_pcb (version 20221018)
  (general (thickness 1.6))
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (setup (stackup
    (layer "F.Cu" (type "copper") (thickness 0.035))
    (layer "dielectric 1" (type "core") (thickness 1.53))
    (layer "B.Cu" (type "copper") (thickness 0.035))
    (copper_finish "None")))
  (net 0 "")
  (net 1 "GND")
  (net 2 "/SDA")
  (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net 1))
)`;

/**
 * A three-sheet project whose second and third sheets share a BASENAME —
 * `sourcesFor` can hand the renderer only one of them, which is the condition
 * the dropped-chip path exists for. U1 lives on the sheet that survives.
 */
/** A tiny but REAL schematic, so the Sheets tab has something to draw. */
const SHEET_TEXT = `(kicad_sch (version 20230121) (paper "A4")
  (lib_symbols (symbol "Device:R" (symbol "R_0_1" (rectangle (start -1 -2.5) (end 1 2.5)))))
  (wire (pts (xy 10 30) (xy 20 30)))
  (symbol (lib_id "Device:R") (at 30 30 0) (unit 1))
)`;

function makeSession(over: { root?: string | null; board?: string | null; boardText?: string; sheetText?: string } = {}) {
  const text = over.sheetText ?? '';
  const sheets = [
    { path: 'main.kicad_sch', uuid: 'r', text },
    { path: 'sub/power.kicad_sch', uuid: 'a', text },
    { path: 'alt/power.kicad_sch', uuid: 'b', text },
  ];
  const board = over.board ?? null;
  const files = new Map(sheets.map((s) => [s.path, s.text]));
  // A board with no text in `files` is the unreadable case, on purpose.
  if (board != null && over.boardText !== '') files.set(board, over.boardText ?? BOARD_TEXT);
  return {
    project: {
      name: 'demo',
      files,
      pro: null,
      root: over.root === undefined ? 'main.kicad_sch' : over.root,
      sheets,
      board,
      warnings: [],
      missingSheets: [],
      formatVersions: {},
    },
    // One line carrying both designators, as the reader would write it.
    parsed: { lines: [{ index: 0, qty: 2, refs: ['U1', 'U2'], value: '10k', footprint: 'R_0402', mpn: null, dnp: false }], warnings: [], error: null },
    refs: new Map([
      ['U1', { sheet: 'sub/power.kicad_sch', instancePath: '/r/a' }],
      ['U2', { sheet: 'main.kicad_sch', instancePath: '/r' }],
      // A part the reader can see in the BOM whose sheet the renderer never got.
      ['U9', { sheet: 'alt/power.kicad_sch', instancePath: '/r/b' }],
    ]),
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(createElement(ViewerPage));
  });
}

/** Re-render in place — what a same-route hash change looks like to the page. */
async function rerender() {
  await render();
}

/** The stackup panel as it stood at ONE commit. */
interface StackupCommit {
  visible: boolean;
  saysUnreadable: boolean;
}

/**
 * Render inside a `<Profiler>` that snapshots the stackup panel at EVERY
 * commit, and hand back the growing record.
 *
 * A post-`act()` assertion cannot see the frame the render-phase term of
 * `stackupWanted` exists for. `act` flushes the selection commit, THEN the
 * latch effect, THEN the re-render before it returns — so a latch-only build
 * has already parsed the board and painted the panel by the time the test
 * looks, and the commit in between, where the panel is visible and still
 * carrying the `role="alert"` "could not be read" copy, has been and gone.
 * `onRender` runs in the commit phase with the DOM already mutated, so it sees
 * each commit the way a screen — and a screen reader — would.
 */
async function renderWatchingStackup(): Promise<StackupCommit[]> {
  const commits: StackupCommit[] = [];
  const probe = () => {
    const panel = container.querySelector('#viewer-panel-stackup');
    if (!(panel instanceof HTMLElement)) return;
    commits.push({
      visible: !panel.hidden,
      saysUnreadable: /could not be read/.test(panel.textContent ?? ''),
    });
  };
  await act(async () => {
    root.render(
      createElement(Profiler, { id: 'viewer', onRender: probe }, createElement(ViewerPage)),
    );
  });
  return commits;
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

function byText(text: string): HTMLButtonElement {
  const found = buttons().find((b) => b.textContent === text);
  if (found == null) throw new Error(`no button "${text}" in: ${buttons().map((b) => b.textContent).join(' | ')}`);
  return found;
}

function bomRef(ref: string): HTMLElement {
  return container.querySelector(`[data-ref="${ref}"]`) as HTMLElement;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

/** Hand back promises the test settles by hand, so two focuses can be in flight
 *  at once — the shape the sequence guard exists for. In a browser the wait is a
 *  sheet load; here it is whatever the test wants. */
function deferFocus(): { ref: string; settle: (result: string) => void }[] {
  const pending: { ref: string; settle: (result: string) => void }[] = [];
  canvas.focusRef.mockImplementation(
    ((ref: string) =>
      new Promise((resolve) => {
        pending.push({ ref, settle: resolve as (result: string) => void });
      })) as never,
  );
  return pending;
}

async function canvasReady() {
  await act(async () => {
    canvas.onState?.('ready');
  });
}

function toastText(): string | null {
  return container.querySelector('[role="status"]')?.textContent ?? null;
}

/** A real bubbling keydown, so it reaches React's handler on the tablist the
 *  way a keyboard does rather than by calling the prop directly. */
async function press(el: HTMLElement, key: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function tabButtons(): HTMLButtonElement[] {
  const list = container.querySelector('[role="tablist"]');
  return list == null ? [] : [...list.querySelectorAll('button')];
}

/** The sheet rows, which live in the drawer's Sheets tab (2026-09-22). */
function chips(): HTMLButtonElement[] {
  const group = container.querySelector('[role="group"][aria-label="Sheets"]');
  return group == null ? [] : [...group.querySelectorAll('button')];
}

function railTab(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('aside [role="tab"]')].find((t) => t.textContent === label);
  if (found == null) throw new Error(`no rail tab "${label}"`);
  return found as HTMLButtonElement;
}

/** Open the drawer on Sheets, where the rows are. */
async function openSheets() {
  if (chips().length === 0) await click(railTab('Sheets'));
}

beforeEach(() => {
  hash = '';
  session = makeSession();
  reopen = () => makeSession();
  wbCalls.length = 0;
  wb.rows = [];
  wb.matching = false;
  // The basename twin of sheet 2, which is what the real KiCanvas controller
  // answers for this fixture (pinned in kicanvasController.test.ts).
  canvas.unrenderable = ['alt/power.kicad_sch'];
  canvas.mounts = 0;
  canvas.focusRef.mockClear();
  canvas.focusRef.mockResolvedValue('focused');
  canvas.selectRef.mockClear();
  canvas.selectRef.mockResolvedValue('focused');
  canvas.activeSheet = undefined;
  canvas.board = [];
  canvas.nets = [];
  canvas.setLayerVisible.mockClear();
  canvas.highlightLayer.mockClear();
  canvas.setObjectOpacity.mockClear();
  canvas.highlightNet.mockClear();
  board3d.props = null;
  readStackupCalls.mockClear();
  readPlacementsCalls.mockClear();
  readSheetThumbnailCalls.mockClear();
  wb.reset.mockClear();
  // The Board panel remembers its dock per browser; a test must start blank.
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('the BOM tab', () => {
  it('is offered only when the project has a schematic', async () => {
    session = makeSession({ root: null, board: 'board.kicad_pcb' });
    await render();
    expect(buttons().map((b) => b.textContent)).not.toContain('BOM');
    expect(buttons().map((b) => b.textContent)).toContain('Board');
  });

  it('prices nothing until it is opened, then never re-prices for that project', async () => {
    await render();
    // Armed but idle: the drawing tab must not spend a match.
    expect(wbCalls.at(-1)).toEqual({ parsed: null, viewerHref: null });

    await click(byText('BOM'));
    const armed = wbCalls.at(-1);
    expect(armed?.parsed).toBe((session as { parsed: unknown }).parsed);
    // The viewer shows the drawing itself, so rows link nowhere — chips act in
    // place through onRefClick instead.
    expect(armed?.viewerHref).toBeNull();

    // Back to the drawing and forward again. A null in between would be a fresh
    // identity transition on the way back = a second /api/bom/match.
    const armedAt = wbCalls.length - 1;
    await click(byText('Schematic'));
    await click(byText('BOM'));
    expect(wbCalls.slice(armedAt).every((c) => c.parsed === (session as { parsed: unknown }).parsed)).toBe(true);
  });

  it('keeps the panel mounted under the drawing tab, hidden rather than unmounted', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await click(byText('BOM'));
    const panel = container.querySelector('[aria-label="Bill of materials"]') as HTMLElement;
    expect(panel.hidden).toBe(false);
    expect(container.querySelector('[data-testid="bom-ref"]')).not.toBeNull();

    await click(byText('Schematic'));
    expect((container.querySelector('[aria-label="Bill of materials"]') as HTMLElement).hidden).toBe(true);
    // Still THERE — unmounting it would bin the priced rows.
    expect(container.querySelector('[data-testid="bom-ref"]')).not.toBeNull();
  });

  it('a row chip focuses the designator on the drawing and comes back to it', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await click(byText('BOM'));
    await click(bomRef('U1'));

    expect(canvas.focusRef).toHaveBeenCalledWith('U1', '/r/a');
    expect(byText('Schematic').getAttribute('aria-selected')).toBe('true');
    // The success copy, on the path the review measured failing: a designator on
    // a sheet other than the one displayed. (That the CONTROLLER survives the
    // host activate this triggers is pinned in kicanvasController.test.ts — the
    // stub here cannot re-activate.)
    expect(toastText()).toBe('Focused U1');
  });

  it('"Open another" resets the workbench and re-arms it at null', async () => {
    await render();
    await click(byText('BOM'));
    await click(byText('Open another'));

    expect(wb.reset).toHaveBeenCalledTimes(1);
    expect(wbCalls.at(-1)).toEqual({ parsed: null, viewerHref: null });
    expect(container.querySelector('[data-testid="intake"]')).not.toBeNull();
  });
});

describe('focusing a reference', () => {
  // I1 — the hash used to be read once, into a ref, at mount.
  it('focuses a #ref that arrives while the page is already mounted', async () => {
    await render();
    await canvasReady();
    expect(canvas.focusRef).not.toHaveBeenCalled();

    hash = '#U1';
    await rerender();
    expect(canvas.focusRef).toHaveBeenCalledWith('U1', '/r/a');
  });

  it('still focuses a #ref the page mounted with, once the canvas is ready', async () => {
    hash = '#U1';
    await render();
    expect(canvas.focusRef).not.toHaveBeenCalled();
    await canvasReady();
    expect(canvas.focusRef).toHaveBeenCalledWith('U1', '/r/a');
  });

  it('reads a hash with a malformed escape rather than throwing out of the effect', async () => {
    hash = '#%';
    await render();
    await canvasReady();
    expect(canvas.focusRef).toHaveBeenCalledWith('%', undefined);
  });

  // I2 — DesignCanvas re-activates on the view flip and can land after
  // focusRef; page state has to already name the designator's sheet.
  it('moves the page to the designator’s own sheet before the drawing settles', async () => {
    await render();
    await canvasReady();
    expect(canvas.activeSheet).toBeUndefined();

    hash = '#U1';
    await rerender();
    expect(canvas.activeSheet).toBe('sub/power.kicad_sch');
    await openSheets();
    expect(chips()[1].getAttribute('aria-current')).toBe('true');
  });

  it('says so when the reference is not in the schematic', async () => {
    canvas.focusRef.mockResolvedValue('not-found' as never);
    hash = '#U1';
    await render();
    await canvasReady();
    expect(toastText()).toBe('U1 was not found on sheet power.kicad_sch');
  });
});

// I4 — sourcesFor drops the basename twin; activate() then returns false and
// nothing between the controller and the page surfaced that boolean.
describe('a sheet the renderer could not be handed', () => {
  it('marks its row and answers the click instead of doing nothing', async () => {
    await render();
    await openSheets();
    const dropped = chips()[2];
    expect(dropped.getAttribute('aria-disabled')).toBe('true');
    expect(dropped.getAttribute('title')).toMatch(/same filename/);

    await click(dropped);
    expect(toastText()).toBe(
      "power.kicad_sch can't be drawn — another sheet in this project has the same filename.",
    );
    // …and the drawing did NOT move to a sheet it cannot show.
    expect(canvas.activeSheet).toBeUndefined();
  });

  it('leaves every other row selectable', async () => {
    await render();
    await openSheets();
    expect(chips()[1].getAttribute('aria-disabled')).toBeNull();
    await click(chips()[1]);
    expect(canvas.activeSheet).toBe('sub/power.kicad_sch');
    expect(toastText()).toBeNull();
  });
});

// MAJOR-2 — the page holds no opinion about which sheets a renderer can draw;
// it renders the answer the mounted one gave it.
describe('the unrenderable-sheet seam', () => {
  it('marks nothing when the renderer reports no dropped sheets', async () => {
    canvas.unrenderable = [];
    await render();
    await openSheets();
    expect(chips()).toHaveLength(3);
    expect(chips().some((c) => c.getAttribute('aria-disabled') === 'true')).toBe(false);
    await click(chips()[2]);
    expect(canvas.activeSheet).toBe('alt/power.kicad_sch');
    expect(toastText()).toBeNull();
  });

  it('marks whichever sheet the renderer named, not one it worked out itself', async () => {
    canvas.unrenderable = ['main.kicad_sch'];
    await render();
    await openSheets();
    expect(chips()[0].getAttribute('aria-disabled')).toBe('true');
    expect(chips()[2].getAttribute('aria-disabled')).toBeNull();
  });

  // MINOR-3
  it('gives the dropped row a described-by reason, not only a title', async () => {
    await render();
    await openSheets();
    const id = chips()[2].getAttribute('aria-describedby');
    expect(id).not.toBeNull();
    const reason = container.querySelector(`#${id}`);
    expect(reason?.textContent).toMatch(/same filename/);
  });
});

// MAJOR-1 — the BOM row was a second door onto the inert state I4 closed.
describe('a designator on a sheet the renderer could not take', () => {
  it('says which part went nowhere and leaves the sheet alone', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await click(byText('BOM'));

    hash = '#U9';
    await rerender();

    expect(toastText()).toBe(
      "U9 is on power.kicad_sch, which can't be drawn \u2014 another sheet in this project has the same filename.",
    );
    expect(canvas.focusRef).not.toHaveBeenCalled();
    // The row this page marks "can't be drawn" must not become the current one.
    expect(canvas.activeSheet).toBeUndefined();
    await click(byText('Schematic'));
    await openSheets();
    expect(chips()[2].getAttribute('aria-current')).toBe('false');
  });
});

// MINOR-1 — every other field was cleared by openAnother; canvasState was not,
// so the page went on believing a drawing was on screen with no canvas mounted.
describe('after the project is closed', () => {
  it('holds a #ref that arrives with nothing open, and focuses it once a project is ready', async () => {
    await render();
    await canvasReady();
    await click(byText('Open another'));

    hash = '#U1';
    await rerender();
    // Consuming it here (which a stale 'ready' does) drops it: focus() returns
    // at once with no session, and nothing is left to replay.
    expect(canvas.focusRef).not.toHaveBeenCalled();

    await click(container.querySelector('[data-testid="intake"]') as HTMLElement);
    await canvasReady();
    expect(canvas.focusRef).toHaveBeenCalledWith('U1', '/r/a');
  });
});

// MINOR-4
describe('a schematic with nothing to buy', () => {
  it('says so instead of showing a blank panel', async () => {
    const s = makeSession();
    s.parsed.lines = [];
    session = s;
    await render();
    await click(byText('BOM'));
    const panel = container.querySelector('[aria-label="Bill of materials"]') as HTMLElement;
    expect(panel.textContent).toMatch(/Nothing to price/);
    expect(panel.textContent?.toLowerCase()).not.toContain('upload');
  });
});

// NEW-1 and the racing-focus residual: a focus is awaited across a sheet load,
// and the reader can act again inside that window.
describe('a gesture made while a focus is still loading', () => {
  it('answers only the newest designator, however the older one lands', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await click(byText('BOM'));
    const pending = deferFocus();

    await click(bomRef('U1'));
    await click(bomRef('U2'));
    expect(pending.map((f) => f.ref)).toEqual(['U1', 'U2']);

    // The newer click lands FIRST and the abandoned one straggles in after —
    // the real shape, since the sheet being left is usually the slower load.
    // Ungoverned, the reader is left reading a verdict on a click they replaced.
    await act(async () => pending[1].settle('focused'));
    await act(async () => pending[0].settle('not-found'));

    expect(toastText()).toBe('Focused U2');
  });

  /**
   * The case the sequence guard alone does NOT cover: a TAB switch moves the
   * canvas without touching `activeSheet`, so nothing on the page bumps the
   * sequence — only the renderer knows it stood down, and only by saying so.
   */
  it('says nothing when the reader switches to the board mid-focus', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await click(byText('BOM'));
    const pending = deferFocus();

    await click(bomRef('U1'));
    await click(byText('Board'));
    await act(async () => pending[0].settle('superseded'));

    expect(toastText()).toBeNull();
  });

  /**
   * And the case 'superseded' alone does not cover: the focus legitimately WON
   * its race and reports 'focused', but by the time it answers the reader has
   * moved to another sheet. "Focused U1" over a drawing showing something else
   * is the page's own invariant to keep, not the renderer's.
   */
  it('does not announce a focus that succeeded after the reader moved on', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await click(byText('BOM'));
    const pending = deferFocus();

    await click(bomRef('U1'));
    await openSheets();
    await click(chips()[0]);
    await act(async () => pending[0].settle('focused'));

    expect(toastText()).toBeNull();
    expect(canvas.activeSheet).toBe('main.kicad_sch');
  });

  it('lets a sheet chip keep the view, and says nothing about the focus it displaced', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await click(byText('BOM'));
    const pending = deferFocus();

    await click(bomRef('U1')); // aims at sub/power
    await openSheets();
    await click(chips()[0]); // …and the reader picks the root instead

    // What the controller reports once it has stood down for that chip.
    await act(async () => pending[0].settle('superseded'));

    expect(canvas.activeSheet).toBe('main.kicad_sch');
    expect(chips()[0].getAttribute('aria-current')).toBe('true');
    expect(toastText()).toBeNull();
  });
});

// Phase 4 — the third tab, and the a11y contract the tablist grew with it.
describe('the Stackup tab', () => {
  const withBoard = () => makeSession({ board: 'main.kicad_pcb' });

  it('is not offered for a project with no board', async () => {
    await render();
    expect(buttons().map((b) => b.textContent)).not.toContain('Stackup');
    expect(container.querySelector('#viewer-panel-stackup')).toBeNull();
  });

  it('sits after Board and before BOM, so the two drawings stay side by side', async () => {
    session = withBoard();
    await render();
    expect(tabButtons().map((b) => b.textContent)).toEqual(['Schematic', 'Board', 'Stackup', '3D', 'BOM']);
  });

  it('shows the layer stack the board file carries', async () => {
    session = withBoard();
    await render();
    await click(byText('Stackup'));

    const panel = container.querySelector('#viewer-panel-stackup') as HTMLElement;
    expect(panel.hidden).toBe(false);
    const text = panel.textContent ?? '';
    // Read by the REAL reader out of the fixture board: two copper layers, a
    // three-row stackup, one through via, and a finish of "None".
    expect(text).toMatch(/F\.Cu/);
    expect(text).toMatch(/dielectric 1/);
    expect(text).toMatch(/none specified/);
    expect(panel.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(panel.querySelector('svg')).not.toBeNull();
  });

  it('says why instead of taking the whole page down when the board cannot be read', async () => {
    // `readStackup` THROWS for anything that is not a board, and `project.ts`
    // picks the board by extension alone. Uncaught, that exception is raised
    // from a render and the ErrorBoundary eats the schematic and the BOM too.
    session = makeSession({ board: 'main.kicad_pcb', boardText: '' });
    await render();
    await click(byText('Stackup'));

    const panel = container.querySelector('#viewer-panel-stackup') as HTMLElement;
    expect(panel.textContent).toMatch(/main\.kicad_pcb could not be read as a KiCad board/);
    // …and the rest of the page is still standing.
    expect(byText('Schematic')).toBeDefined();
    expect(byText('BOM')).toBeDefined();
    expect(container.querySelector('[data-testid="canvas"]')).not.toBeNull();
  });

  it('keeps the ONE canvas embed alive across the trip to the stackup and back', async () => {
    session = withBoard();
    await render();
    const embed = container.querySelector('[data-testid="canvas"]');
    const mounted = canvas.mounts;
    expect(mounted).toBe(1);

    await click(byText('Stackup'));
    await click(byText('Board'));
    await click(byText('Stackup'));
    await click(byText('Schematic'));

    // The same NODE, and no second mount: re-mounting the embed would re-fetch
    // the renderer and redraw the board from scratch on a tab click.
    expect(container.querySelector('[data-testid="canvas"]')).toBe(embed);
    expect(canvas.mounts).toBe(mounted);
  });

  it('reads the board on the FIRST visit to the tab, and only once for the session', async () => {
    // `readStackup` re-tokenises the whole board — 323 ms on an 8 MB one — and
    // it used to run on project open, charged to every reader who came for the
    // schematic and never opened this tab.
    session = withBoard();
    await render();
    expect(byText('Schematic').getAttribute('aria-selected')).toBe('true');
    expect(readStackupCalls).not.toHaveBeenCalled();

    await click(byText('Stackup'));
    expect(readStackupCalls).toHaveBeenCalledTimes(1);

    // Latched: leaving and returning must not re-read a board that has not
    // changed. (Unlatched, the memo's gate would fall back to false on the way
    // out and parse again on the way in.)
    await click(byText('Board'));
    await click(byText('Stackup'));
    expect(readStackupCalls).toHaveBeenCalledTimes(1);
  });

  it('never shows "could not be read" about a board it has not tried to read yet', async () => {
    // The panel is mounted for the whole session, so the latch alone would let
    // the commit that first reveals the tab paint the error copy — and
    // role="alert" would ANNOUNCE it — before the read had happened at all.
    //
    // Judged per COMMIT, because the latch repairs it one commit later and a
    // post-`act` read sees only the repair: this is what makes the gate's
    // `|| tab === 'stackup'` term load-bearing rather than decorative.
    session = withBoard();
    const commits = await renderWatchingStackup();
    await click(byText('Stackup'));

    const shown = commits.filter((c) => c.visible);
    // Not vacuous: the tab really was revealed while the probe was watching.
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.map((c) => c.saysUnreadable)).not.toContain(true);

    const panel = container.querySelector('#viewer-panel-stackup') as HTMLElement;
    expect(panel.textContent).not.toMatch(/could not be read/);
    expect(panel.querySelector('svg')).not.toBeNull();
  });

  it('leaves the chosen sheet alone — a non-drawing tab is not a sheet gesture', async () => {
    session = withBoard();
    await render();
    await canvasReady();
    await openSheets();
    await click(chips()[1]);
    expect(canvas.activeSheet).toBe('sub/power.kicad_sch');

    await click(byText('Stackup'));
    await click(byText('Schematic'));
    expect(canvas.activeSheet).toBe('sub/power.kicad_sch');
  });
});

describe('the 3D tab', () => {
  it('offers a 3D tab for a project with a board, mounts the view only while selected, and unmounts on leaving', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    const tab3d = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === '3D')!;
    expect(tab3d).toBeDefined();
    expect(container.querySelector('[data-testid="board3d"]')).toBeNull();
    await click(tab3d as HTMLElement);
    expect(container.querySelector('[data-testid="board3d"]')).not.toBeNull();
    expect(tab3d.getAttribute('aria-selected')).toBe('true');
    const stackupTab = [...container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'Stackup')!;
    await click(stackupTab as HTMLElement);
    expect(container.querySelector('[data-testid="board3d"]')).toBeNull();
  });

  it('a schematic-only project has no 3D tab', async () => {
    await render();
    expect([...container.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).not.toContain('3D');
    expect(container.querySelector('#viewer-panel-3d')).toBeNull();
  });

  it('wires the tab to its panel only while that panel exists', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    expect(byText('3D').getAttribute('aria-controls')).toBeNull();
    await click(byText('3D'));
    const panel = container.querySelector('#viewer-panel-3d');
    expect(byText('3D').getAttribute('aria-controls')).toBe('viewer-panel-3d');
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(byText('3D').id);
  });

  it('hands the 3D view the board’s own layer stack, read once for the session', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    expect(readStackupCalls).not.toHaveBeenCalled();
    await click(byText('3D'));
    expect(readStackupCalls).toHaveBeenCalledTimes(1);
    await click(byText('Stackup'));
    expect(readStackupCalls).toHaveBeenCalledTimes(1);
  });

  it('a return to the 3D tab reuses the layer stack instead of re-reading the board', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    await click(byText('3D'));
    await click(byText('Board'));
    await click(byText('3D'));
    expect(readStackupCalls).toHaveBeenCalledTimes(1);
  });

  it('keeps the ONE canvas embed alive across the trip to 3D and back', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    const before = canvas.mounts;
    await click(byText('3D'));
    await click(byText('Board'));
    expect(canvas.mounts).toBe(before);
  });
});

describe('the tablist contract', () => {
  it('pairs every tab with the panel it opens, both ways', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    const list = container.querySelector('[role="tablist"]') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe('Views');

    for (const t of tabButtons()) {
      expect(t.getAttribute('role')).toBe('tab');
      expect(t.getAttribute('aria-selected')).not.toBeNull();
      expect(t.id).not.toBe('');
      const controls = t.getAttribute('aria-controls');
      // Neither the BOM panel (not in the document until the tab is first
      // opened) nor the 3D panel (mounted only while selected) is here yet, and
      // a reference to an absent element is worse than none.
      if (t.textContent === 'BOM' || t.textContent === '3D') {
        expect(controls).toBeNull();
        continue;
      }
      const panel = container.querySelector(`#${controls}`);
      expect(panel, `no panel for ${t.textContent}`).not.toBeNull();
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      const labelledBy = panel?.getAttribute('aria-labelledby');
      // Never a dangling reference, whichever panel it is…
      expect(tabButtons().some((b) => b.id === labelledBy), `${labelledBy} is not a tab`).toBe(true);
      // …and where a panel has exactly one tab, that tab. The drawing panel is
      // the deliberate exception: two tabs, one embed, so it is named by
      // whichever of them is live (asserted just below).
      if (controls !== 'viewer-panel-drawing') expect(labelledBy).toBe(t.id);
    }

    // Both drawing tabs name the SAME region — one embed, two labels — and the
    // region is labelled by whichever of them is live.
    const [schematic, board] = tabButtons();
    expect(schematic!.getAttribute('aria-controls')).toBe(board!.getAttribute('aria-controls'));
    const drawing = container.querySelector('#viewer-panel-drawing');
    expect(drawing?.getAttribute('aria-labelledby')).toBe(schematic!.id);
    await click(board!);
    expect(container.querySelector('#viewer-panel-drawing')?.getAttribute('aria-labelledby')).toBe(board!.id);
  });

  it('wires the BOM tab to its panel once that panel exists', async () => {
    await render();
    await click(byText('BOM'));
    const tab = byText('BOM');
    const panel = container.querySelector(`#${tab.getAttribute('aria-controls')}`);
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
  });

  it('is ONE tab stop: only the selected tab is reachable by Tab', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    expect(tabButtons().map((b) => b.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    // The negative half of the contract: every OTHER tab says "false", or a
    // stuck-on attribute tells a screen reader all five views are open.
    expect(tabButtons().map((b) => b.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    await click(byText('Stackup'));
    expect(tabButtons().map((b) => b.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    expect(tabButtons().map((b) => b.getAttribute('aria-selected'))).toEqual(['false', 'false', 'true', 'false', 'false']);
  });

  it('moves focus AND selection with the arrows, wrapping at both ends', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    const list = container.querySelector('[role="tablist"]') as HTMLElement;

    await press(list, 'ArrowRight');
    expect(byText('Board').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(byText('Board'));

    await press(list, 'ArrowRight');
    expect(byText('Stackup').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('#viewer-panel-stackup')).not.toBeNull();
    expect((container.querySelector('#viewer-panel-stackup') as HTMLElement).hidden).toBe(false);

    await press(list, 'ArrowLeft');
    expect(byText('Board').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(byText('Board'));

    // Off the left end and round to the last tab.
    await press(list, 'ArrowLeft');
    await press(list, 'ArrowLeft');
    expect(byText('BOM').getAttribute('aria-selected')).toBe('true');
    await press(list, 'ArrowRight');
    expect(byText('Schematic').getAttribute('aria-selected')).toBe('true');
  });

  it('jumps to the first and last tab with Home and End', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    const list = container.querySelector('[role="tablist"]') as HTMLElement;

    await press(list, 'End');
    expect(byText('BOM').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(byText('BOM'));

    await press(list, 'Home');
    expect(byText('Schematic').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(byText('Schematic'));
  });

  it('leaves a key it does not handle to the browser', async () => {
    await render();
    const list = container.querySelector('[role="tablist"]') as HTMLElement;
    const before = byText('Schematic').getAttribute('aria-selected');
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    await act(async () => {
      list.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(byText('Schematic').getAttribute('aria-selected')).toBe(before);
  });
});


// The part panel — one selection for the page, whichever door it came through.
describe('the part panel', () => {
  const panel = () => container.querySelector('aside') as HTMLElement;
  const search = () => container.querySelector('input[aria-label="Find a reference"]') as HTMLInputElement;
  const headRef = () => panel().querySelector('p')?.textContent ?? null;

  async function type(text: string) {
    const input = search();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  }

  it('starts empty, with the search and an invitation, on every tab', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    expect(panel()).not.toBeNull();
    expect(search()).not.toBeNull();
    expect(panel().textContent).toMatch(/Click a part/);
    await click(byText('Stackup'));
    expect(panel().textContent).toMatch(/Click a part/);
    await click(byText('BOM'));
    expect(panel().textContent).toMatch(/Click a part/);
  });

  it('a click on the drawing identifies the part and marks its BOM chip', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await act(async () => canvas.onSelection?.({ ref: 'U1', sheet: '/r/a', view: 'schematic' }));
    expect(headRef()).toBe('U1');
    expect(panel().textContent).toMatch(/Show on/);
    // The drawing already shows it: nothing is sent back to the canvas.
    expect(canvas.selectRef).not.toHaveBeenCalled();
    await click(byText('BOM'));
    expect((container.querySelector('[data-testid="bom-ref"]') as HTMLElement).dataset.selected).toBe('U1');
    // …and clicking nothing clears it.
    await click(byText('Schematic'));
    await act(async () => canvas.onSelection?.({ ref: null, view: 'schematic' }));
    expect(panel().textContent).toMatch(/Click a part/);
  });

  it('holds the table\u2019s supplier pins, so the panel can price a line the way the table does', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await click(byText('BOM'));
    expect(bomTable.props?.pins).toEqual({});
    await act(async () => (bomTable.props?.onPinsChange as (p: Record<number, string>) => void)({ 0: 's2' }));
    expect(bomTable.props?.pins).toEqual({ 0: 's2' });
  });

  it('a BOM chip selects as well as focusing', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await click(byText('BOM'));
    await click(bomRef('U1'));
    expect(headRef()).toBe('U1');
    expect(canvas.focusRef).toHaveBeenCalledWith('U1', '/r/a');
  });

  it('the search resolves a designator in any case and takes the schematic to it', async () => {
    await render();
    await canvasReady();
    await type('u1');
    expect(headRef()).toBe('U1');
    expect(canvas.focusRef).toHaveBeenCalledWith('U1', '/r/a');
    expect(canvas.activeSheet).toBe('sub/power.kicad_sch');
  });

  it('the sheets live in the drawer as rows with a picture each, drawn on the first visit, and a row is a trip to that sheet', async () => {
    session = makeSession({ board: 'main.kicad_pcb', sheetText: SHEET_TEXT });
    await render();
    await canvasReady();
    // Nothing above the drawing: the stage is the drawing.
    expect(container.querySelector('#viewer-panel-drawing')!.previousElementSibling).toBeNull();
    expect(readSheetThumbnailCalls).not.toHaveBeenCalled();
    await click(byText('BOM'));
    await openSheets();
    // Inside the panel, three rows, the root marked, the root current.
    const group = container.querySelector('[role="group"][aria-label="Sheets"]') as HTMLElement;
    expect(panel().contains(group)).toBe(true);
    expect(chips()).toHaveLength(3);
    expect(chips()[0].textContent).toContain('main');
    expect(chips()[0].textContent).toContain('root');
    expect(chips()[0].getAttribute('aria-current')).toBe('true');
    // A picture of each sheet, read from the file once, on this first visit.
    expect(readSheetThumbnailCalls).toHaveBeenCalledTimes(3);
    expect(group.querySelectorAll('svg[data-sheet-thumb]')).toHaveLength(3);
    expect(chips()[0].textContent).toContain('1 symbol');
    // Choosing a row from the BOM tab goes to the Schematic tab AND the sheet.
    await click(chips()[1]);
    expect(byText('Schematic').getAttribute('aria-selected')).toBe('true');
    expect(canvas.activeSheet).toBe('sub/power.kicad_sch');
    expect(chips()[1].getAttribute('aria-current')).toBe('true');
    // Back and forth: no second read.
    await click(railTab('Parts'));
    await click(railTab('Sheets'));
    expect(readSheetThumbnailCalls).toHaveBeenCalledTimes(3);
  });

  it('on a phone, a search from the open sheet keeps it open; a selection from outside collapses it', async () => {
    await render();
    await canvasReady();
    // The peek is the handle row's own button; the rail tabs carry aria-expanded too.
    const peek = panel().querySelector('button[aria-expanded]:not([role="tab"])') as HTMLButtonElement;
    await click(peek);
    expect(panel().dataset.open).toBeDefined();
    await type('u1');
    expect(headRef()).toBe('U1');
    // The reader opened the sheet to ask; the answer stays on screen.
    expect(panel().dataset.open).toBeDefined();
    await act(async () => canvas.onSelection?.({ ref: null, view: 'schematic' }));
    expect(panel().dataset.open).toBeUndefined();
  });

  it('the search says so for a designator nobody knows, and Esc clears it', async () => {
    await render();
    await canvasReady();
    await type('U99');
    expect(panel().textContent).toMatch(/U99/);
    expect(panel().textContent).toMatch(/Not in this project/);
    expect(canvas.focusRef).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(panel().textContent).toMatch(/Click a part/);
    // The drawing is told to drop its outline only when it had one.
    expect(canvas.selectRef).not.toHaveBeenCalledWith(null);
  });

  it('"/" focuses the search unless the reader is already typing', async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    });
    expect(document.activeElement).toBe(search());
  });

  it('arriving at the board carries the selection over without a zoom, and "Show on Board" zooms', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    wb.rows = [{ index: 0 }];
    await render();
    await canvasReady();
    await click(byText('BOM'));
    await click(bomRef('U1'));
    canvas.focusRef.mockClear();
    await click(byText('Board'));
    expect(canvas.selectRef).toHaveBeenCalledWith('U1', undefined, 'board');
    expect(canvas.focusRef).not.toHaveBeenCalled();
    // Back on the schematic the outline follows, on the designator's own sheet.
    canvas.selectRef.mockClear();
    await click(byText('Schematic'));
    expect(canvas.selectRef).toHaveBeenCalledWith('U1', '/r/a', 'schematic');
    // The panel's own button is the travel gesture.
    const show = [...panel().querySelectorAll('[aria-label="Show on"] button')].find((b) => b.textContent === 'Board') as HTMLButtonElement;
    await click(show);
    expect(byText('Board').getAttribute('aria-selected')).toBe('true');
    expect(canvas.focusRef).toHaveBeenCalledWith('U1', undefined, 'board');
  });

  it('a selection the SCHEMATIC reported is still carried onto the board on arrival', async () => {
    // The stub canvas echoes what the controller does: a click reports the
    // designator with its view. A view-blind "the canvas already has it" check
    // skipped the board whenever the schematic had reported the same designator.
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    await canvasReady();
    await act(async () => canvas.onSelection?.({ ref: 'U1', sheet: '/r/a', view: 'schematic' }));
    expect(canvas.selectRef).not.toHaveBeenCalled();
    await click(byText('Board'));
    expect(canvas.selectRef).toHaveBeenCalledWith('U1', undefined, 'board');
    // …and a designator the schematic never lists outlines in place, never by
    // naming the schematic view (which would activate the root sheet).
    canvas.selectRef.mockClear();
    await act(async () => canvas.onSelection?.({ ref: 'H1', view: 'board' }));
    await click(byText('Schematic'));
    expect(canvas.selectRef).toHaveBeenCalledWith('H1');
    expect(canvas.selectRef).not.toHaveBeenCalledWith('H1', undefined, 'schematic');
  });

  it('a selection cleared on one drawing is cleared on the other when the reader returns', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    await canvasReady();
    // Both drawings have outlined U1 (the schematic by a click, the board on arrival).
    await act(async () => canvas.onSelection?.({ ref: 'U1', sheet: '/r/a', view: 'schematic' }));
    await click(byText('Board'));
    await act(async () => canvas.onSelection?.({ ref: 'U1', view: 'board' }));
    canvas.selectRef.mockClear();
    // Esc on the board clears the board now…
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(canvas.selectRef).toHaveBeenCalledWith(null);
    await act(async () => canvas.onSelection?.({ ref: null, view: 'board' }));
    canvas.selectRef.mockClear();
    // …and the schematic, which still outlines U1, on the way back — once.
    await click(byText('Schematic'));
    expect(canvas.selectRef).toHaveBeenCalledWith(null);
    await act(async () => canvas.onSelection?.({ ref: null, view: 'schematic' }));
    canvas.selectRef.mockClear();
    await click(byText('Board'));
    await click(byText('Schematic'));
    expect(canvas.selectRef).not.toHaveBeenCalled();
  });

  it('a selection the drawing could not find clears its record, so the part is outlined again later', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    await canvasReady();
    // The board outlines U1.
    await click(byText('Board'));
    await act(async () => canvas.onSelection?.({ ref: 'U1', view: 'board' }));
    // On the schematic, a footprint-less symbol is selected; back on the board
    // the select MISSES — and a miss clears the board's outline.
    await click(byText('Schematic'));
    await act(async () => canvas.onSelection?.({ ref: 'U2', sheet: '/r', view: 'schematic' }));
    canvas.selectRef.mockResolvedValueOnce('not-found' as never);
    await click(byText('Board'));
    expect(canvas.selectRef).toHaveBeenCalledWith('U2', undefined, 'board');
    // U1 again, from the schematic: the board must be told, not skipped as
    // "already shown".
    await click(byText('Schematic'));
    await act(async () => canvas.onSelection?.({ ref: 'U1', sheet: '/r/a', view: 'schematic' }));
    canvas.selectRef.mockClear();
    await click(byText('Board'));
    expect(canvas.selectRef).toHaveBeenCalledWith('U1', undefined, 'board');
  });

  it('a pick in the 3D view identifies the part and the 3D view is told what is selected', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    await click(byText('3D'));
    await click(container.querySelector('[data-testid="pick3d"]') as HTMLElement);
    expect(headRef()).toBe('U2');
    expect((container.querySelector('[data-testid="board3d"]') as HTMLElement).dataset.selected).toBe('U2');
    // Off the 3D tab and onto the schematic: the outline follows without a zoom.
    await canvasReady();
    await click(byText('Schematic'));
    expect(canvas.selectRef).toHaveBeenCalledWith('U2', '/r', 'schematic');
  });

  it('warms the placement table at the first idle moment, so the first selection does not pay for it', async () => {
    const idle: (() => void)[] = [];
    vi.stubGlobal('requestIdleCallback', (fn: () => void) => idle.push(fn));
    vi.stubGlobal('cancelIdleCallback', () => {});
    try {
      session = makeSession({ board: 'main.kicad_pcb' });
      await render();
      await canvasReady();
      expect(readPlacementsCalls).not.toHaveBeenCalled();
      await act(async () => { for (const fn of idle.splice(0)) fn(); });
      expect(readPlacementsCalls).toHaveBeenCalledTimes(1);
      await act(async () => canvas.onSelection?.({ ref: 'U1', sheet: '/r/a', view: 'schematic' }));
      expect(readPlacementsCalls).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads the board\u2019s placements on the first selection, and only then', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    await canvasReady();
    // The fixture board has no footprints, so the facts show dashes — the point
    // is WHEN the file is scanned, which readStackupCalls cannot see; the panel
    // renders the position row only once a part is selected.
    expect(panel().textContent).not.toMatch(/Position/);
    await act(async () => canvas.onSelection?.({ ref: 'U1', sheet: '/r/a', view: 'schematic' }));
    expect(panel().textContent).toMatch(/Position/);
    expect(panel().textContent).toMatch(/Sheet/);
  });

  it('offers to price the BOM when the project is not priced yet, and prices it on the click', async () => {
    await render();
    await canvasReady();
    await act(async () => canvas.onSelection?.({ ref: 'U1', sheet: '/r/a', view: 'schematic' }));
    const btn = [...panel().querySelectorAll('button')].find((b) => /Price the BOM/.test(b.textContent ?? ''));
    expect(btn).toBeDefined();
    await click(btn as HTMLButtonElement);
    expect(byText('BOM').getAttribute('aria-selected')).toBe('true');
    expect(wbCalls.at(-1)?.parsed).toBe((session as { parsed: unknown }).parsed);
  });

  it('"Open another" clears the selection with the project', async () => {
    await render();
    await canvasReady();
    await act(async () => canvas.onSelection?.({ ref: 'U1', sheet: '/r/a', view: 'schematic' }));
    await click(byText('Open another'));
    await click(container.querySelector('[data-testid="intake"]') as HTMLElement);
    expect(panel().textContent).toMatch(/Click a part/);
  });
});

// The tab strip is one track that shares its width on a phone: the fifth tab
// used to push it 40px past a 390px screen. Class names prove nothing under
// vitest (CSS is off), so this reads the stylesheet.
describe('the Board panel', () => {
  const aside = () => container.querySelector('aside') as HTMLElement;
  const panelTab = (label: string) =>
    [...aside().querySelectorAll('[role="tab"]')].find((t) => t.textContent === label) as HTMLButtonElement;
  const layerBox = (name: string) => aside().querySelector(`input[aria-label="Show ${name}"]`) as HTMLInputElement;
  const fakeLayer = (name: string): FakeLayer => ({
    name, kind: 'copper', side: name[0], color: 'rgba(1, 2, 3, 1)', visible: true, highlighted: false,
  });

  /** The Board tab, with its board loaded and reporting — as the controller does. */
  async function boardLoaded() {
    await click(byText('Board'));
    await canvasReady();
    canvas.board = [fakeLayer('F.Cu'), fakeLayer('B.Cu')];
    canvas.nets = [{ number: 1, name: 'GND' }, { number: 2, name: '/SDA' }];
    await act(async () => canvas.onLayers?.(canvas.board.map((l) => ({ ...l }))));
  }

  beforeEach(() => {
    session = makeSession({ board: 'main.kicad_pcb' });
  });

  it('is Sheets and Parts, and nothing of the board, for a project with no board', async () => {
    session = makeSession();
    await render();
    expect(aside().getAttribute('aria-label')).toBe('Design panel');
    expect([...aside().querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Sheets', 'Parts']);
  });

  it('is the part panel alone, with no tabs, for a drop with neither a schematic nor a board', async () => {
    session = makeSession({ root: null });
    await render();
    expect(aside().getAttribute('aria-label')).toBe('Part');
    expect(aside().querySelector('[role="tablist"]')).toBeNull();
  });

  it('offers Sheets, Parts, Layers and Objects, and disables the board tabs on the schematic with the reason', async () => {
    await render();
    expect(aside().getAttribute('aria-label')).toBe('Board panel');
    expect([...aside().querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(['Sheets', 'Parts', 'Layers', 'Objects']);
    expect(panelTab('Parts').getAttribute('aria-selected')).toBe('true');
    expect(panelTab('Layers').getAttribute('aria-disabled')).toBe('true');
    expect(panelTab('Layers').title).toBe('Open the Board or 3D tab');
    await click(panelTab('Layers'));
    // Disabled: the Parts tab stays.
    expect(panelTab('Parts').getAttribute('aria-selected')).toBe('true');
    expect(aside().textContent).toMatch(/Click a part/);
  });

  it('lists the board’s layers from the file on the 3D tab, and the 3D view draws the same state', async () => {
    await render();
    await click(byText('3D'));
    await click(panelTab('Layers'));
    expect(panelTab('Layers').getAttribute('aria-selected')).toBe('true');
    expect(layerBox('F.Cu').checked).toBe(true);
    await click(layerBox('B.Cu'));
    expect(layerBox('B.Cu').checked).toBe(false);
    expect([...(board3d.props?.hiddenLayers as Set<string>)]).toEqual(['B.Cu']);
    // Back to the schematic: the tab says why it cannot act, and keeps its place.
    await click(byText('Schematic'));
    expect(aside().textContent).toMatch(/Open the Board or 3D tab/);
  });

  it('a layer hidden on the Board tab stays hidden after Board → 3D → Board, even across a reload of the board', async () => {
    await render();
    await boardLoaded();
    await click(panelTab('Layers'));
    // The board's own list, in its own colours.
    expect(layerBox('F.Cu')).not.toBeNull();
    await click(layerBox('B.Cu'));
    expect(canvas.setLayerVisible).toHaveBeenLastCalledWith('B.Cu', false);

    await click(byText('3D'));
    expect((board3d.props?.hiddenLayers as Set<string>).has('B.Cu')).toBe(true);
    expect(layerBox('B.Cu').checked).toBe(false);

    // The board comes back with a fresh layer set (every layer shown), as a
    // reload leaves it; the page puts its choice back.
    canvas.setLayerVisible.mockClear();
    // Not on screen yet as the tab switches: the renderer answers [] until the
    // board is back, and its `layers` event is the cue.
    canvas.board = [];
    await click(byText('Board'));
    expect(canvas.setLayerVisible).not.toHaveBeenCalled();
    canvas.board = [fakeLayer('F.Cu'), fakeLayer('B.Cu')];
    await act(async () => canvas.onLayers?.(canvas.board.map((l) => ({ ...l }))));
    expect(canvas.setLayerVisible.mock.calls).toEqual([['B.Cu', false]]);
    expect(layerBox('B.Cu').checked).toBe(false);
    // The echo of that call changes nothing more.
    canvas.setLayerVisible.mockClear();
    await act(async () => canvas.onLayers?.(canvas.board.map((l) => ({ ...l }))));
    expect(canvas.setLayerVisible).not.toHaveBeenCalled();
  });

  it('Objects fades a class on the board and lists the board’s nets; a net lights on click and clears on a second', async () => {
    await render();
    await boardLoaded();
    await click(panelTab('Objects'));
    const labels = [...aside().querySelectorAll('input[type="range"]')].map((r) => (aside().querySelector(`label[for="${r.id}"]`) as HTMLElement).textContent);
    expect(labels).toEqual(['Tracks', 'Vias', 'Pads', 'Through-holes', 'Zones', 'Grid', 'Page']);
    await click(aside().querySelector('input[aria-label="Show zones"]') as HTMLElement);
    expect(canvas.setObjectOpacity).toHaveBeenLastCalledWith('zones', 0);

    const net = () => [...aside().querySelectorAll('button[aria-pressed]')].find((b) => b.textContent === 'GND') as HTMLButtonElement;
    await click(net());
    expect(canvas.highlightNet).toHaveBeenLastCalledWith(1);
    expect(net().getAttribute('aria-pressed')).toBe('true');
    await click(net());
    expect(canvas.highlightNet).toHaveBeenLastCalledWith(null);

    // The 3D tab offers its own classes, with the same shared opacity.
    await click(byText('3D'));
    const labels3d = [...aside().querySelectorAll('input[type="range"]')].map((r) => (aside().querySelector(`label[for="${r.id}"]`) as HTMLElement).textContent);
    expect(labels3d).toEqual(['Tracks', 'Vias', 'Pads', 'Zones', 'Silkscreen', 'Mask', 'Bodies']);
    expect((board3d.props?.opacity as Record<string, number>).zones).toBe(0);
  });

  it('Esc clears a lit net first, then the selection', async () => {
    wb.rows = [{ index: 0 }];
    await render();
    await boardLoaded();
    await act(async () => canvas.onSelection?.({ ref: 'U1', view: 'board' }));
    await click(panelTab('Objects'));
    await click([...aside().querySelectorAll('button[aria-pressed]')].find((b) => b.textContent === 'GND') as HTMLButtonElement);
    const esc = async () => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    };
    await esc();
    expect(canvas.highlightNet).toHaveBeenLastCalledWith(null);
    await click(panelTab('Parts'));
    expect(aside().querySelector('p')?.textContent).toBe('U1');
    await esc();
    expect(aside().textContent).toMatch(/Click a part/);
  });

  it('starts over with every layer shown when another project is opened', async () => {
    await render();
    await click(byText('3D'));
    await click(panelTab('Layers'));
    await click(layerBox('F.Cu'));
    expect((board3d.props?.hiddenLayers as Set<string>).size).toBe(1);
    reopen = () => makeSession({ board: 'main.kicad_pcb' });
    await click(byText('Open another'));
    await click(container.querySelector('[data-testid="intake"]') as HTMLElement);
    await click(byText('3D'));
    expect((board3d.props?.hiddenLayers as Set<string>).size).toBe(0);
    await click(panelTab('Layers'));
    expect(layerBox('F.Cu').checked).toBe(true);
  });
});

describe('the tab strip stylesheet', () => {
  const scss = readFileSync(join(__dirname, 'ViewerPage.module.scss'), 'utf8');
  it('is a single track that stretches on a phone and lets every tab share the width', () => {
    expect(scss).toMatch(/\.tabs \{[^{}]*display:\s*inline-flex/);
    const mobile = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    expect(mobile).toMatch(/\.tabs \{[^{}]*align-self:\s*stretch/);
    expect(mobile).toMatch(/\.tab \{[^{}]*flex:\s*1 1 auto/);
    // …and never scrolls sideways again.
    expect(scss).not.toMatch(/\.tabs \{[^{}]*overflow-x/);
  });
  it('gives the phone sheet an opaque base and draws each fact hairline unbroken', () => {
    const panelScss = readFileSync(join(__dirname, 'components', 'BoardPanel.module.scss'), 'utf8');
    const mobile = panelScss.slice(panelScss.indexOf('@include responsive($bp-tablet)'));
    const sheet = mobile.slice(mobile.indexOf('.panel {'), mobile.indexOf('.peek {'));
    // Under the washes sits a solid colour, not another translucent gradient —
    // the mode's own: the token is a plain hex in both sets.
    expect(sheet).toMatch(/background-color:\s*var\(--vw-card-solid\)/);
    const tokens = readFileSync(join(__dirname, '_workspaceTokens.scss'), 'utf8');
    expect(tokens.match(/--vw-card-solid:\s*(#[0-9a-f]{6});/g)).toHaveLength(2);
    expect(panelScss).toMatch(/\.facts \{[^{}]*gap:\s*0;/);
  });
  it('keeps the stage clear of the bottom sheet on a phone and a tablet', () => {
    // The sheet reaches up to $bp-tablet: a docked drawer at 820 would leave
    // the stage 430px and the BOM table two columns. Its handle row is 52px
    // and the workspace keeps exactly that much clear below itself.
    const mobile = scss.slice(scss.indexOf('@include responsive($bp-tablet)'));
    expect(mobile.slice(0, mobile.indexOf('@include responsive($bp-mobile)'))).toMatch(/\.workspace \{[^{}]*padding-bottom:\s*52px/);
    const panelScss = readFileSync(join(__dirname, 'components', 'BoardPanel.module.scss'), 'utf8');
    expect(panelScss).toMatch(/@include responsive\(\$bp-tablet\) \{\s*\.panel \{[^{}]*position:\s*fixed/);
  });
});

// The workspace (owner, 2026-09-22): once a project is open the page is one
// full-height instrument, and fullscreen takes ALL of it.
describe('the workspace', () => {
  /** happy-dom has no Fullscreen API: stand one up that records the element. */
  let fullscreenEl: Element | null = null;
  const requestFullscreen = vi.fn(function (this: Element) {
    fullscreenEl = this;
    document.dispatchEvent(new Event('fullscreenchange'));
    return Promise.resolve();
  });
  beforeEach(() => {
    fullscreenEl = null;
    requestFullscreen.mockClear();
    Object.defineProperty(document, 'fullscreenEnabled', { value: true, configurable: true });
    Object.defineProperty(document, 'fullscreenElement', { get: () => fullscreenEl, configurable: true });
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { value: requestFullscreen, configurable: true, writable: true });
    Object.defineProperty(document, 'exitFullscreen', {
      value: () => {
        fullscreenEl = null;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      },
      configurable: true,
      writable: true,
    });
  });

  const workspace = () => container.querySelector('aside')!.parentElement!.parentElement as HTMLElement;
  const fsButton = () => [...container.querySelectorAll('button')].find((b) => /fullscreen/i.test(b.getAttribute('aria-label') ?? ''))!;
  /** The night switch: named by its visible word, its state in aria-pressed. */
  const nightBtn = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Night')!;

  it('has no band once a project is open, and its status line carries the privacy sentence and the credit', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    // The intake's intro is gone with the intake; the sentence lives on in the
    // workspace's own footer, word for word.
    const status = [...container.querySelectorAll('p')].find((p) => /never leave your browser/.test(p.textContent ?? ''))!;
    expect(status).toBeDefined();
    expect(status.textContent).toContain('Your design files never leave your browser.');
    expect(status.textContent).toContain('Rendering by KiCanvas');
    expect(status.querySelector('a')?.getAttribute('href')).toBe('/vendor/kicanvas/NOTICE.txt');
    // …and it is inside the workspace, so fullscreen keeps it.
    expect(workspace().contains(status)).toBe(true);
    // The top bar names the project and the way out.
    expect(workspace().textContent).toContain('demo');
    expect(byText('Open another')).toBeDefined();
  });

  it('takes the WHOLE workspace fullscreen from the top bar, and tells the canvas to do the same', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    await canvasReady();
    expect(fsButton().getAttribute('aria-pressed')).toBe('false');
    await click(fsButton());
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    // The element asked was the workspace — the rail, the drawer, the tabs and
    // the status line are all inside it — never the drawing's frame.
    expect(fullscreenEl).toBe(workspace());
    expect(workspace().contains(container.querySelector('aside'))).toBe(true);
    expect(workspace().contains(container.querySelector('[role="tablist"][aria-label="Views"]'))).toBe(true);
    expect(fsButton().getAttribute('aria-pressed')).toBe('true');
    expect(fsButton().getAttribute('aria-label')).toBe('Exit fullscreen');
    // The drawing's overlay button is pointed at the same element.
    expect(canvas.fullscreenTarget?.()).toBe(workspace());
    await click(fsButton());
    expect(fullscreenEl).toBeNull();
    expect(fsButton().getAttribute('aria-pressed')).toBe('false');
    // The same button, the same element, from the 3D tab — which has no
    // overlay button of its own.
    await click(byText('3D'));
    expect(container.querySelector('[data-testid="board3d"]')).not.toBeNull();
    await click(fsButton());
    expect(fullscreenEl).toBe(workspace());
    expect(workspace().contains(container.querySelector('[data-testid="board3d"]'))).toBe(true);
  });

  it('folds the read’s notes behind a count in the top bar', async () => {
    const s = makeSession({ board: 'main.kicad_pcb' });
    s.parsed.warnings = ['213 symbols skipped: 0 not in BOM, 213 power, virtual or unreferenced.'];
    s.project.warnings = ['One file was ignored.'];
    session = s;
    await render();
    const details = workspace().querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.querySelector('summary')?.textContent).toContain('2 notes');
    expect(details.textContent).toContain('213 symbols skipped');
    expect(details.textContent).toContain('One file was ignored.');
  });

  it('keeps a missing sheet as an alert under the bar, never folded into the notes', async () => {
    const t = makeSession({ board: 'main.kicad_pcb' });
    t.project.missingSheets = ['io_extra.kicad_sch'];
    session = t;
    await render();
    // Not the stackup panel's own (hidden) alert: the strip is a direct child
    // of the workspace, under the top bar.
    const alert = [...workspace().querySelectorAll('[role="alert"]')].find((a) => /Missing sheet/.test(a.textContent ?? ''))!;
    expect(alert).toBeDefined();
    expect(alert.textContent).toMatch(/Missing sheet file: io_extra\.kicad_sch/);
    expect(alert.parentElement).toBe(workspace());
    expect(workspace().querySelector('details')).toBeNull();
  });

  it('starts in the day, the toggle turns the workspace to night, and the choice is remembered', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    await render();
    const night = nightBtn();
    expect(night).toBeDefined();
    // One toggle on the top bar, in the end cluster beside fullscreen: a word
    // and a glyph, the word constant, the state carried by aria-pressed.
    expect(night.parentElement).toBe(fsButton().parentElement);
    expect(night.querySelector('i.ph-moon')).not.toBeNull();
    expect(night.getAttribute('aria-label')).toBeNull();
    expect(workspace().dataset.mode).toBe('day');
    expect(night.getAttribute('aria-pressed')).toBe('false');
    expect(night.title).toBe('Switch to night');
    expect(localStorage.getItem('cc.viewer.mode')).toBeNull();
    await click(night);
    expect(workspace().dataset.mode).toBe('night');
    expect(nightBtn().getAttribute('aria-pressed')).toBe('true');
    expect(nightBtn().textContent).toBe('Night');
    expect(nightBtn().title).toBe('Back to day');
    expect(localStorage.getItem('cc.viewer.mode')).toBe('night');
    // A fresh mount reads it back.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(workspace().dataset.mode).toBe('night');
    await click(nightBtn());
    expect(workspace().dataset.mode).toBe('day');
    expect(localStorage.getItem('cc.viewer.mode')).toBe('day');
  });

  it('a first visit follows the system, without writing; a stored choice beats the system', async () => {
    session = makeSession({ board: 'main.kicad_pcb' });
    const original = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      value: (media: string) => ({ media, matches: media === '(prefers-color-scheme: dark)', addEventListener() {}, removeEventListener() {} }),
      configurable: true,
      writable: true,
    });
    try {
      await render();
      expect(workspace().dataset.mode).toBe('night');
      expect(nightBtn().getAttribute('aria-pressed')).toBe('true');
      // Following the system writes nothing: a reader who never touched the
      // switch keeps following it when the system changes.
      expect(localStorage.getItem('cc.viewer.mode')).toBeNull();
      await act(async () => root.unmount());
      localStorage.setItem('cc.viewer.mode', 'day');
      root = createRoot(container);
      await render();
      expect(workspace().dataset.mode).toBe('day');
      // And a value that is not ours falls back to the system, not to day.
      await act(async () => root.unmount());
      localStorage.setItem('cc.viewer.mode', 'dusk');
      root = createRoot(container);
      await render();
      expect(workspace().dataset.mode).toBe('night');
    } finally {
      if (original) Object.defineProperty(window, 'matchMedia', original);
      else delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('draws the toast inside the workspace', async () => {
    await render();
    await canvasReady();
    hash = '#U1';
    await rerender();
    expect(toastText()).toBe('Focused U1');
    expect(workspace().contains(container.querySelector('[role="status"]'))).toBe(true);
  });
});

// The workspace: the viewport below the navbar and nothing more, the stage
// bounded so the BOM scrolls inside it, the drawer docked beside the rail.
describe('the workspace stylesheet', () => {
  const scss = readFileSync(join(__dirname, 'ViewerPage.module.scss'), 'utf8');
  const panelScss = readFileSync(join(__dirname, 'components', 'BoardPanel.module.scss'), 'utf8');

  it('is exactly the viewport below the navbar, on a desktop and on a phone', () => {
    // `height` interpolates a variable (`#{…}`), so the rule is read up to its
    // closing brace by hand rather than with a brace-free scan.
    const desktop = scss.slice(scss.indexOf('.workspace {'));
    expect(desktop.slice(0, desktop.indexOf('\n}'))).toMatch(/height:\s*calc\(100dvh - #\{\$nav-height\}\)/);
    const mobile = scss.slice(scss.indexOf('@include responsive($bp-mobile)'));
    const mobileWs = mobile.slice(mobile.indexOf('.workspace {'));
    expect(mobileWs.slice(0, mobileWs.indexOf('\n  }'))).toMatch(/height:\s*calc\(100dvh - #\{\$nav-height-mobile\}\)/);
    // The stage scrolls on its own; the workspace never grows past the viewport.
    expect(scss).toMatch(/\.stage \{[^{}]*overflow:\s*auto/);
    expect(scss).toMatch(/\.stage \{[^{}]*min-height:\s*0/);
  });

  it('docks the drawer beside a 48px rail at Altium’s width, and only when docked', () => {
    expect(panelScss).toMatch(/\$rail-w:\s*48px/);
    expect(panelScss).toMatch(/\$drawer-w:\s*340px/);
    expect(panelScss).toMatch(/\.panel\[data-docked\] \.drawer \{[^{}]*display:\s*flex/);
    // Closed is closed: the bare `.drawer` draws nothing.
    expect(panelScss).toMatch(/\n\.drawer \{\s*display:\s*none;\s*\}/);
    // Never a card inside the instrument: the frame's radius and shadow go.
    expect(scss).toMatch(/> :first-child \{[^{}]*border-radius:\s*0/);
    expect(scss).toMatch(/> :first-child \{[^{}]*box-shadow:\s*none/);
  });

  it('keeps the toast inside the workspace so fullscreen still shows it', () => {
    expect(scss).toMatch(/\.toast \{[^{}]*position:\s*fixed/);
  });

  it('draws day and night from one set of names, and carries no literal ink of its own', () => {
    const tokens = readFileSync(join(__dirname, '_workspaceTokens.scss'), 'utf8');
    expect(tokens).toMatch(/@mixin workspace-day-tokens/);
    expect(tokens).toMatch(/@mixin workspace-night-tokens/);
    // The root declares the day set and re-declares the night set under the attribute.
    expect(scss).toMatch(/\.workspace \{\s*@include workspace-day-tokens;/);
    expect(scss).toMatch(/&\[data-mode='night'\] \{\s*@include workspace-night-tokens;/);
    // Every name the day set declares, the night set declares too.
    const names = (block: string) => [...block.matchAll(/--vw-[a-z0-9-]+(?=:)/g)].map((m) => m[0]).sort();
    const day = tokens.slice(tokens.indexOf('@mixin workspace-day-tokens'), tokens.indexOf('@mixin workspace-night-tokens'));
    const night = tokens.slice(tokens.indexOf('@mixin workspace-night-tokens'), tokens.indexOf('// ── The control recipes'));
    expect(names(night)).toEqual(names(day));
    // The three viewer stylesheets read the names; the old literal inks are gone.
    const controls = readFileSync(join(__dirname, 'components', 'BoardControls.module.scss'), 'utf8');
    for (const [file, text] of [['ViewerPage', scss], ['BoardPanel', panelScss], ['BoardControls', controls]] as const) {
      for (const literal of ['#1a1f23', '#676c71', '#4b5158', '#2b3137', 'rgba(26, 31, 35, 0.1)']) {
        expect(text, `${file} still carries ${literal}`).not.toContain(literal);
      }
    }
    // Night is the instrument, and the browser is told so (form controls,
    // scrollbars); the site's red and the drop-frame's gold each have a night
    // ink, because neither reads on the dark bench as it is.
    expect(scss).toMatch(/&\[data-mode='night'\] \{[^{}]*color-scheme:\s*dark/);
    expect(scss).toMatch(/\.alert \{[^{}]*color:\s*var\(--vw-alert-ink\)/);
    expect(scss).toMatch(/\.phaseWarn \{[^{}]*color:\s*var\(--vw-warn-ink\)/);
    expect(scss).toMatch(/\.pageError \{[^{}]*color:\s*var\(--vw-alert-ink\)/);
    // A placeholder is text, so it takes the tertiary ink, never the disabled one.
    expect(tokens).toMatch(/&::placeholder \{[^{}]*color:\s*var\(--vw-ink-3\)/);
  });

  it('the night switch is a word and a glyph, 44px to a finger, and switches with no motion', () => {
    expect(scss).toMatch(/\.modeBtn \{[^{}]*min-height:\s*40px/);
    expect(scss).toMatch(/@mixin topbar-button \{[\s\S]*?@include tap-target\(-2px\)/);
    expect(scss).toMatch(/\.modeLabel \{[^{}]+\}/);
    // Nothing on the workspace root tweens: the change of mode is instant.
    const rootBlock = scss.slice(scss.indexOf('.workspace {'), scss.indexOf('// ─── Top bar'));
    expect(rootBlock).not.toMatch(/transition|animation/);
    const reduced = scss.slice(scss.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.modeBtn[\s\S]*?transition:\s*none/);
  });

  it('the sheet rows are a finger tall, the picture is paper in the mode’s own white, and the lit row’s count line steps up an ink', () => {
    expect(panelScss).toMatch(/\.sheetRow \{[^{}]*min-height:\s*80px/);
    expect(panelScss).toMatch(/\.thumbPaper \{[^{}]*fill:\s*var\(--vw-thumb-paper\)/);
    expect(panelScss).toMatch(/&\[aria-current='true'\] \{[^{}]*background:\s*var\(--vw-lit-bg\)[\s\S]*?\.sheetMeta \{[^{}]*color:\s*var\(--vw-ink-2\)/);
    // Non-scaling strokes are the SVG's; the stylesheet gives them KiCad's own inks.
    expect(panelScss).toMatch(/\.thumbWires \{[^{}]*stroke:\s*#1a7a3a/);
    expect(panelScss).toMatch(/\.thumbSymbols \{[^{}]*stroke:\s*#8e2a2a/);
  });
});
