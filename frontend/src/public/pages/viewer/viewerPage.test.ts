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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AnyProps = Record<string, never> & Record<string, unknown>;

let hash = '';
let session: unknown = null;

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
  focusRef: vi.fn(async (_ref: string, _sheet?: string) => 'focused' as const),
};

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
    useImperativeHandle(ref, () => ({ focusRef: canvas.focusRef, zoom: async () => true }), []);
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
vi.mock('@public/components/kicad/board3d/Board3DView', () => ({
  default: () => createElement('div', { 'data-testid': 'board3d' }),
}));
vi.mock('@public/components/bom/BomTable', () => ({
  default: (props: AnyProps) =>
    createElement(
      'div',
      { 'data-testid': 'bom-ref' },
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
    ),
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
vi.mock('@public/services/designSession', () => ({
  getDesignSession: () => session,
  clearDesignSession: () => {
    session = null;
  },
  openDesign: () => {
    session = makeSession();
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
  (via (at 1 1) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu"))
)`;

/**
 * A three-sheet project whose second and third sheets share a BASENAME —
 * `sourcesFor` can hand the renderer only one of them, which is the condition
 * the dropped-chip path exists for. U1 lives on the sheet that survives.
 */
function makeSession(over: { root?: string | null; board?: string | null; boardText?: string } = {}) {
  const sheets = [
    { path: 'main.kicad_sch', uuid: 'r', text: '' },
    { path: 'sub/power.kicad_sch', uuid: 'a', text: '' },
    { path: 'alt/power.kicad_sch', uuid: 'b', text: '' },
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
    parsed: { lines: [{ index: 0, qty: 2 }], warnings: [], error: null },
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

function chips(): HTMLButtonElement[] {
  const group = container.querySelector('[aria-label="Sheets"]');
  return group == null ? [] : [...group.querySelectorAll('button')];
}

beforeEach(() => {
  hash = '';
  session = makeSession();
  wbCalls.length = 0;
  wb.rows = [];
  wb.matching = false;
  // The basename twin of sheet 2, which is what the real KiCanvas controller
  // answers for this fixture (pinned in kicanvasController.test.ts).
  canvas.unrenderable = ['alt/power.kicad_sch'];
  canvas.mounts = 0;
  canvas.focusRef.mockClear();
  canvas.focusRef.mockResolvedValue('focused');
  canvas.activeSheet = undefined;
  readStackupCalls.mockClear();
  wb.reset.mockClear();
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
  it('marks its chip and answers the click instead of doing nothing', async () => {
    await render();
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

  it('leaves every other chip selectable', async () => {
    await render();
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
    expect(chips()).toHaveLength(3);
    expect(chips().some((c) => c.getAttribute('aria-disabled') === 'true')).toBe(false);
    await click(chips()[2]);
    expect(canvas.activeSheet).toBe('alt/power.kicad_sch');
    expect(toastText()).toBeNull();
  });

  it('marks whichever sheet the renderer named, not one it worked out itself', async () => {
    canvas.unrenderable = ['main.kicad_sch'];
    await render();
    expect(chips()[0].getAttribute('aria-disabled')).toBe('true');
    expect(chips()[2].getAttribute('aria-disabled')).toBeNull();
  });

  // MINOR-3
  it('gives the dropped chip a described-by reason, not only a title', async () => {
    await render();
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
    // The chip this page marks "can't be drawn" must not become the current one.
    expect(canvas.activeSheet).toBeUndefined();
    await click(byText('Schematic'));
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
