// @vitest-environment happy-dom
/**
 * The /bom page's KiCad wiring (spec §7.2) — the parts a playtest cannot check
 * cheaply or reproducibly.
 *
 * The load-bearing one is the LAST describe: a project can be open in this tab
 * while the table on screen is a CSV somebody dropped afterwards, and every
 * design-derived affordance (the viewer link on a designator, the schematic
 * panel, the session-clearing "Change file") has to be able to tell the two
 * apart. The page answers with the identity of the parse — the same fact the
 * workbench keys its one match on — so these tests hold a session open and
 * price something ELSE through it.
 *
 * No JSX: this is a `*.test.ts` (the only shape vitest discovers here, and the
 * shape `tsc -b`/eslint exclude), so elements are built with createElement.
 * There is no testing-library — createRoot + act, as viewerPage.test.ts does.
 */
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type AnyProps = Record<string, never> & Record<string, unknown>;

let session: ReturnType<typeof makeSession> | null = null;

/** What the stubbed intake was last rendered with, and the handlers the tests
 *  drive it through — standing in for a drop, a paste and the continue button. */
const intake = {
  onParsed: null as ((result: unknown, name: string, text: string) => void) | null,
  session: undefined as unknown,
  onContinue: null as (() => void) | null,
};

/** Every (parsed, viewerHref) pair the page has handed the workbench, in order
 *  — the record that proves both "one match per project" and "no viewer route
 *  on a BOM that is not the design". */
const wbCalls: { parsed: unknown; viewerHref: unknown }[] = [];

/** What BomTable was last rendered with. `onRefClick` present means the chips
 *  are buttons acting in place; absent means they fall back to the link. */
const table = {
  onRefClick: undefined as ((ref: string) => void) | undefined,
};

const canvas = {
  project: null as unknown,
  view: '' as string,
  height: undefined as string | undefined,
  focusRef: vi.fn(async (_ref: string, _sheet?: string) => 'focused' as const),
};

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
  useParams: () => ({}),
  Link: (props: AnyProps) => createElement('a', { href: props.to as string }, props.children as never),
}));
vi.mock('framer-motion', () => ({
  motion: { div: (props: AnyProps) => createElement('div', null, props.children as never) },
}));
vi.mock('@public/components/PageHead', () => ({ default: () => null }));
vi.mock('@public/components/layout/PageHeaderBand', () => ({ default: () => null }));
vi.mock('@public/services/bom/bomApi', () => ({ bomApi: { getShare: vi.fn() } }));
vi.mock('./components/BomIntake', () => ({
  default: (props: AnyProps) => {
    intake.onParsed = props.onParsed as (result: unknown, name: string, text: string) => void;
    intake.session = props.session;
    intake.onContinue = props.onContinue as (() => void) | null;
    // The real button is rendered on exactly this condition (both props present).
    return props.session != null && props.onContinue != null
      ? createElement(
          'button',
          { type: 'button', 'data-testid': 'continue', onClick: props.onContinue as () => void },
          'continue',
        )
      : createElement('div', { 'data-testid': 'intake' });
  },
}));
vi.mock('./components/ColumnMapper', () => ({
  default: () => createElement('div', { 'data-testid': 'mapper' }),
}));
vi.mock('@public/components/bom/BomTable', () => ({
  default: (props: AnyProps) => {
    table.onRefClick = props.onRefClick as ((ref: string) => void) | undefined;
    const click = props.onRefClick as ((ref: string) => void) | undefined;
    return createElement(
      'div',
      { 'data-testid': 'table' },
      ['U1', 'U9'].map((ref) =>
        createElement(
          'button',
          {
            key: ref,
            type: 'button',
            'data-ref': ref,
            onClick: () => click?.(ref),
          },
          ref,
        ),
      ),
    );
  },
}));
vi.mock('@public/components/bom/ShareBar', () => ({
  default: (props: AnyProps) =>
    createElement(
      'button',
      { type: 'button', 'data-testid': 'change-file', onClick: props.onChangeFile as () => void },
      'Change file',
    ),
  formatShareDate: (iso: string) => iso,
}));
vi.mock('@public/components/kicad/DesignCanvas', () => ({
  default: forwardRef(function CanvasStub(props: AnyProps, ref: never) {
    canvas.project = props.project;
    canvas.view = props.view as string;
    canvas.height = props.height as string | undefined;
    useImperativeHandle(ref, () => ({ focusRef: canvas.focusRef, zoom: async () => true }), []);
    return createElement('div', { 'data-testid': 'canvas' });
  }),
}));
vi.mock('@public/services/bom/useBomWorkbench', () => ({
  useBomWorkbench: (parsed: unknown, viewerHref: unknown) => {
    wbCalls.push({ parsed, viewerHref });
    return wb;
  },
}));
vi.mock('@public/services/designSession', () => ({
  getDesignSession: () => session,
  clearDesignSession: () => {
    session = null;
  },
}));

const { default: BomPage } = await import('./index');

/** A two-sheet project whose U9 lives on a SUB-sheet: focusing it is what the
 *  instance path exists for, and the page must hand it over rather than leave
 *  the renderer on whichever sheet it happens to be showing. */
function makeSession(over: { root?: string | null } = {}) {
  const sheets = [
    { path: 'main.kicad_sch', uuid: 'r', text: '' },
    { path: 'sub/power.kicad_sch', uuid: 'a', text: '' },
  ];
  return {
    project: {
      name: 'glasgow',
      files: new Map(sheets.map((s) => [s.path, s.text])),
      pro: null,
      root: over.root === undefined ? 'main.kicad_sch' : over.root,
      sheets,
      board: 'main.kicad_pcb',
      warnings: ['sub/power.kicad_sch was dropped twice; the last copy is the one shown.'],
      missingSheets: ['io.kicad_sch'],
      formatVersions: {},
    },
    parsed: {
      lines: [{ index: 0, qty: 2 }],
      headers: ['Reference', 'Qty', 'Value'],
      headerSignature: 'kicad-sch',
      roleByColumn: ['refs', 'qty', 'value'],
      unmappedColumns: [],
      warnings: ['One symbol had no value.'],
      error: null,
    },
    refs: new Map([
      ['U1', { sheet: 'main.kicad_sch', instancePath: '/r' }],
      ['U9', { sheet: 'sub/power.kicad_sch', instancePath: '/r/a' }],
    ]),
  };
}

/** What a CSV drop hands the page: a parse of its own, with no design behind it. */
function csvParse() {
  return {
    lines: [{ index: 0, qty: 1 }],
    headers: ['MPN', 'Qty'],
    headerSignature: 'mpn|qty',
    roleByColumn: ['mpn', 'qty'],
    unmappedColumns: [],
    warnings: [],
    error: null,
  };
}

let container: HTMLDivElement;
let root: Root;

async function render() {
  await act(async () => {
    root.render(createElement(BomPage));
  });
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

function byText(text: string): HTMLButtonElement | undefined {
  return buttons().find((b) => b.textContent === text);
}

function testid(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`);
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
}

/** The drop path, exactly as the intake performs it: the session is published
 *  FIRST (the real `openDesign` runs in the drop handler), then the page is
 *  handed that same parse. */
async function dropProject(over: { root?: string | null } = {}) {
  const next = makeSession(over);
  session = next;
  await act(async () => {
    intake.onParsed?.(next.parsed, next.project.name, '');
  });
  return next;
}

async function dropCsv(parsed: unknown = csvParse()) {
  await act(async () => {
    intake.onParsed?.(parsed, 'bom.csv', 'MPN,Qty\nLM317T,4\n');
  });
  return parsed;
}

beforeEach(() => {
  session = null;
  wbCalls.length = 0;
  intake.onParsed = null;
  intake.onContinue = null;
  intake.session = undefined;
  table.onRefClick = undefined;
  canvas.project = null;
  canvas.height = undefined;
  canvas.focusRef.mockClear();
  wb.rows = [{ index: 0 }];
  wb.matching = false;
  wb.reset.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('a KiCad project dropped on /bom', () => {
  it('prices straight away, with no column mapper in the way', async () => {
    await render();
    await dropProject();
    // A schematic read builds its own columns, so there is nothing to ask about.
    expect(testid('mapper')).toBeNull();
    expect(testid('table')).not.toBeNull();
  });

  it('prices the schematic parse ONCE, by identity', async () => {
    await render();
    const s = await dropProject();
    const priced = wbCalls.filter((c) => c.parsed != null);
    expect(priced.length).toBeGreaterThan(0);
    // Every non-null call is the SAME object: a second identity would be a
    // second /api/bom/match and a second bite of the resolve budget.
    expect(new Set(priced.map((c) => c.parsed)).size).toBe(1);
    expect(priced[0]?.parsed).toBe(s.parsed);
  });

  it('stamps the viewer route on the rows', async () => {
    await render();
    await dropProject();
    expect(wbCalls.at(-1)?.viewerHref).toBe('/viewer');
  });

  it('offers no viewer route for a board-only project — there is no schematic to focus into', async () => {
    await render();
    await dropProject({ root: null });
    expect(wbCalls.at(-1)?.viewerHref).toBeNull();
    expect(byText('Show schematic')).toBeUndefined();
  });

  it('carries the project\'s own warnings, not just the parser\'s', async () => {
    await render();
    await dropProject();
    const text = container.textContent ?? '';
    expect(text).toContain('was dropped twice');
    expect(text).toContain('One symbol had no value.');
    // A missing sheet is a missing PART of this BOM, and nothing else says so.
    expect(text).toContain('io.kicad_sch');
  });
});

describe('the schematic beside the table', () => {
  it('is closed until asked for, and mounts the session project when opened', async () => {
    await render();
    const s = await dropProject();
    expect(testid('canvas')).toBeNull();
    await click(byText('Show schematic') as HTMLElement);
    expect(testid('canvas')).not.toBeNull();
    expect(canvas.project).toBe(s.project);
    expect(canvas.view).toBe('schematic');
    expect(canvas.height).toBe('compact');
  });

  it('gives the chips a click handler only while it is open — otherwise they stay links', async () => {
    await render();
    await dropProject();
    expect(table.onRefClick).toBeUndefined();
    await click(byText('Show schematic') as HTMLElement);
    expect(table.onRefClick).toBeDefined();
    await click(byText('Hide schematic') as HTMLElement);
    expect(table.onRefClick).toBeUndefined();
  });

  it('focuses a designator on its OWN sheet, by instance path', async () => {
    await render();
    await dropProject();
    await click(byText('Show schematic') as HTMLElement);
    await click(container.querySelector('[data-ref="U9"]') as HTMLElement);
    expect(canvas.focusRef).toHaveBeenCalledWith('U9', '/r/a');
  });

  it('closes when the reader changes file', async () => {
    await render();
    await dropProject();
    await click(byText('Show schematic') as HTMLElement);
    await click(testid('change-file') as HTMLElement);
    expect(testid('canvas')).toBeNull();
    expect(byText('Show schematic')).toBeUndefined();
  });
});

describe('continuing from the viewer', () => {
  it('is offered only when a project is open', async () => {
    await render();
    expect(testid('continue')).toBeNull();
    session = makeSession();
    await render();
    expect(testid('continue')).not.toBeNull();
  });

  it('prices the session parse without re-reading the schematic', async () => {
    session = makeSession();
    await render();
    await click(testid('continue') as HTMLElement);
    const priced = wbCalls.filter((c) => c.parsed != null);
    expect(new Set(priced.map((c) => c.parsed)).size).toBe(1);
    expect(priced[0]?.parsed).toBe(session?.parsed);
    expect(wbCalls.at(-1)?.viewerHref).toBe('/viewer');
  });
});

describe('a BOM that is not the open design', () => {
  it('gets no viewer route, even while a project is open in this tab', async () => {
    session = makeSession();
    await render();
    await dropCsv();
    // The chips of somebody's CSV must not link into an unrelated schematic.
    expect(wbCalls.at(-1)?.viewerHref).toBeNull();
  });

  it('is offered no schematic panel', async () => {
    session = makeSession();
    await render();
    await dropCsv();
    expect(byText('Show schematic')).toBeUndefined();
    expect(table.onRefClick).toBeUndefined();
  });

  it('does not close the project when the reader changes file', async () => {
    session = makeSession();
    await render();
    await dropCsv();
    await click(testid('change-file') as HTMLElement);
    // The project is still open — losing it from /viewer without being asked
    // is not what "Change file" on a CSV means.
    expect(session).not.toBeNull();
    expect(testid('continue')).not.toBeNull();
  });

  it('DOES close the project when the table being abandoned is that project', async () => {
    await render();
    await dropProject();
    await click(testid('change-file') as HTMLElement);
    expect(session).toBeNull();
    expect(wb.reset).toHaveBeenCalled();
  });
});
