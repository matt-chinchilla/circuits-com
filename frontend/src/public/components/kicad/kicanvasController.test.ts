// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { KicadProject } from '@public/services/kicad/types';
import { KicanvasController, sourcesFor } from './kicanvasController';

interface FakePage { type: 'pcb' | 'schematic'; filename: string; sheet_path: string; project_path: string }

/** `KiCanvasLoadEvent.type` — vendor viewers/base/events.ts:13-14. */
const LOAD = 'kicanvas:load';

function project(files: Record<string, string>, extra: Partial<KicadProject> = {}): KicadProject {
  const map = new Map(Object.entries(files));
  const sheets = [...map.keys()].filter((k) => k.endsWith('.kicad_sch')).map((path) => ({ path, uuid: `u-${path}`, text: map.get(path) as string }));
  return { name: 'p', files: map, pro: null, root: sheets[0]?.path ?? null, sheets, board: [...map.keys()].find((k) => k.endsWith('.kicad_pcb')) ?? null, warnings: [], missingSheets: [], formatVersions: {}, ...extra };
}

function makeViewer(hasDoc: boolean, selectedFor: string[], log: string[]) {
  return Object.assign(new EventTarget(), {
    document: (hasDoc ? { filename: 'x.kicad_sch' } : null) as { filename: string } | null,
    selected: false as boolean | string,
    select(ref: string) {
      log.push(ref);
      this.selected = selectedFor.includes(ref) ? ref : false;
    },
    zoom_to_selection() { /* no-op */ },
  });
}

/** A fake embed: a shadow root holding fake app elements with the public
 *  surface the controller relies on (project, viewer). The viewers are real
 *  EventTargets that dispatch `kicanvas:load` on every page switch, because that
 *  is the only signal an instance switch within ONE file produces. */
function fakeEmbed(opts: {
  pages: FakePage[];
  selectedFor?: string[];
  boardSelectedFor?: string[];
  viewerDoc?: boolean;
  withProject?: boolean;
  /** Dispatch the load event on a later turn, to prove activate() waits for it. */
  asyncLoad?: boolean;
  onLoad?: (projectPath: string) => void;
}) {
  const embed = document.createElement('kicanvas-embed');
  const shadow = embed.attachShadow({ mode: 'open' });
  let active: FakePage | null = null;
  const selected: string[] = [];
  const boardSelected: string[] = [];
  const viewer = makeViewer(opts.viewerDoc !== false, opts.selectedFor ?? [], selected);
  const boardViewer = makeViewer(opts.viewerDoc !== false, opts.boardSelectedFor ?? [], boardSelected);
  const proj = {
    pages: () => opts.pages,
    get active_page() { return active; },
    // Mirrors upstream exactly: project.ts:274 assigns the FIRST page
    // unconditionally, so on a board-bearing project this is the PCB.
    root_schematic_page: opts.pages[0] ?? null,
    set_active_page(p: FakePage | string) {
      active = typeof p === 'string' ? (opts.pages.find((x) => x.project_path === p) ?? null) : p;
      const page = active;
      if (page != null && opts.viewerDoc !== false) {
        // The viewer loads the page's FILE: two instances of one file share a filename.
        viewer.document = { filename: page.filename };
        boardViewer.document = { filename: page.filename };
      }
      const fire = () => {
        if (page != null) opts.onLoad?.(page.project_path);
        viewer.dispatchEvent(new Event(LOAD));
        boardViewer.dispatchEvent(new Event(LOAD));
      };
      // A macrotask, deliberately: a microtask would land before activate()'s own
      // continuation regardless of whether it waited, faking the proof below.
      if (opts.asyncLoad) setTimeout(fire, 0);
      else fire();
    },
  };
  const sch = document.createElement('kc-schematic-app') as HTMLElement & { project?: unknown; viewer?: unknown };
  if (opts.withProject !== false) sch.project = proj;
  sch.viewer = viewer;
  shadow.appendChild(sch);
  const board = document.createElement('kc-board-app') as HTMLElement & { project?: unknown; viewer?: unknown };
  if (opts.withProject !== false) board.project = proj;
  board.viewer = boardViewer;
  shadow.appendChild(board);
  // The real embed sets an active page after load; the fake does it immediately.
  proj.set_active_page(proj.root_schematic_page ?? opts.pages[0]!);
  return { embed, selected, boardSelected, getActive: () => active, viewer, boardViewer, proj, sch, board };
}

const PAGES: FakePage[] = [
  { type: 'schematic', filename: 'main.kicad_sch', sheet_path: '/r', project_path: 'main.kicad_sch' },
  { type: 'schematic', filename: 'sub.kicad_sch', sheet_path: '/r/a', project_path: 'sub.kicad_sch:/r/a' },
  { type: 'schematic', filename: 'sub.kicad_sch', sheet_path: '/r/b', project_path: 'sub.kicad_sch:/r/b' },
  { type: 'pcb', filename: 'main.kicad_pcb', sheet_path: '', project_path: 'main.kicad_pcb' },
];

function controller(fake: ReturnType<typeof fakeEmbed>, readyMs = 500) {
  return new KicanvasController({ loadModule: async () => undefined, createEmbed: () => fake.embed, readyMs, settleMs: 50, sleep: async () => undefined });
}

describe('sourcesFor', () => {
  it('emits the project file first, then sheets, then the board, by basename', () => {
    const p = project({ 'a/main.kicad_sch': 's', 'a/sub/io.kicad_sch': 't', 'a/main.kicad_pcb': 'b', 'a/main.kicad_pro': '{}' });
    const { sources, dropped } = sourcesFor(p);
    expect(sources.map((s) => [s.name, s.type])).toEqual([['main.kicad_pro', 'project'], ['main.kicad_sch', 'schematic'], ['io.kicad_sch', 'schematic'], ['main.kicad_pcb', 'board']]);
    expect(dropped).toEqual([]);
  });
  it('drops a second file with the same basename and names it — KiCanvas cannot tell them apart', () => {
    const p = project({ 'main.kicad_sch': 's', 'x/reg.kicad_sch': 't', 'y/reg.kicad_sch': 'u' });
    expect(sourcesFor(p).dropped).toEqual(['y/reg.kicad_sch']);
  });
});

describe('KicanvasController', () => {
  it('mounts, reports ready, and activates sheets and the board through the public project', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c = controller(fake);
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    const host = document.createElement('div');
    await c.mount(host, project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't', 'main.kicad_pcb': 'b' }));
    expect(states).toEqual(['loading', 'ready']);
    expect(host.firstElementChild?.tagName.toLowerCase()).toBe('kicanvas-embed');
    const sch = fake.embed.shadowRoot!.querySelector('kc-schematic-app') as HTMLElement;
    const brd = fake.embed.shadowRoot!.querySelector('kc-board-app') as HTMLElement;
    // mount() ends with an activate(), so exactly one app is visible before `ready`.
    expect([sch.hidden, brd.hidden]).toEqual([false, true]);
    expect(await c.activate('board')).toBe(true);
    expect(fake.getActive()?.type).toBe('pcb');
    expect([sch.hidden, brd.hidden]).toEqual([true, false]);
    expect(await c.activate('schematic', 'sub.kicad_sch')).toBe(true);
    expect([sch.hidden, brd.hidden]).toEqual([false, true]);
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/a');
    expect(await c.activate('schematic', '/r/b')).toBe(true);
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/b');
    expect(await c.activate('schematic', 'nope.kicad_sch')).toBe(false);
  });

  it('finds the root schematic by TYPE, because upstream hands back the board as root_schematic_page', async () => {
    // project.ts:274 reassigns root_schematic_page to the first page and PCBs are
    // inserted first (:133-144) — Glasgow revC3 is exactly this shape.
    const boardFirst: FakePage[] = [PAGES[3]!, PAGES[0]!, PAGES[1]!, PAGES[2]!];
    const fake = fakeEmbed({ pages: boardFirst });
    expect(fake.proj.root_schematic_page?.type).toBe('pcb');
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'main.kicad_pcb': 'b' }));
    expect(fake.getActive()?.type).toBe('schematic');
    expect(fake.getActive()?.filename).toBe('main.kicad_sch');
    expect([fake.sch.hidden, fake.board.hidden]).toEqual([false, true]);
  });

  it('waits for the viewer load event when two instances share one file', async () => {
    const order: string[] = [];
    const fake = fakeEmbed({ pages: PAGES, asyncLoad: true, onLoad: (p) => order.push(`load:${p}`) });
    // A sleep that yields to the macrotask queue, so the load event can actually land.
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 500,
      settleMs: 500,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    order.length = 0;
    await c.activate('schematic', '/r/a');
    order.push('activated:/r/a');
    // Same FILE, different instance: `document.filename` is identical on both sides,
    // so only the load event can tell the caller the switch really happened.
    await c.activate('schematic', '/r/b');
    order.push('activated:/r/b');
    expect(order).toEqual(['load:sub.kicad_sch:/r/a', 'activated:/r/a', 'load:sub.kicad_sch:/r/b', 'activated:/r/b']);
  });

  it('focuses a reference, reports not-found when the viewer did not select, and unsupported without a document', async () => {
    const fake = fakeEmbed({ pages: PAGES, selectedFor: ['U1'] });
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(await c.focusRef('U1')).toBe('focused');
    expect(await c.focusRef('R999')).toBe('not-found');
    expect(fake.selected).toEqual(['U1', 'R999']);
    const noDoc = fakeEmbed({ pages: PAGES, viewerDoc: false });
    const c2 = controller(noDoc);
    await c2.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(await c2.focusRef('U1')).toBe('unsupported');
  });

  it('focuses on the BOARD when the board is active — BoardViewer.select takes a ref too', async () => {
    const fake = fakeEmbed({ pages: PAGES, selectedFor: ['U1'], boardSelectedFor: ['U7'] });
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'main.kicad_pcb': 'b' }));
    expect(await c.activate('board')).toBe(true);
    expect(await c.focusRef('U7')).toBe('focused');
    expect(fake.boardSelected).toEqual(['U7']);
    expect(fake.selected).toEqual([]); // the schematic viewer was never asked
    expect(await c.focusRef('U1')).toBe('not-found'); // present on the sheet, not the board
  });

  it('times out when no app element carries a project, unmounts the embed, and reports it', async () => {
    const fake = fakeEmbed({ pages: PAGES, withProject: false });
    const c = controller(fake, 120);
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    const host = document.createElement('div');
    await c.mount(host, project({ 'main.kicad_sch': 's' }));
    expect(states).toEqual(['loading', 'timeout']);
    expect(host.childElementCount).toBe(0);
    expect(await c.activate('board')).toBe(false);
  });

  it('refunds the REAL time a hidden tab spends, so a slow mount is not falsely timed out', async () => {
    // A chained setTimeout in a hidden tab is throttled to ~1 s, so a fixed 50 ms
    // refund gives back a twentieth of what the wait cost and the budget drains.
    const fake = fakeEmbed({ pages: PAGES, withProject: false });
    let clock = 0;
    let waits = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 15000,
      settleMs: 50,
      now: () => clock,
      visibility: () => 'hidden',
      sleep: async () => {
        clock += 1000;
        if (++waits === 20) fake.sch.project = fake.proj; // the embed finally loads
      },
    });
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(states).toEqual(['loading', 'ready']);
    expect(waits).toBe(20); // 20 s of hidden time on a 15 s budget, all refunded
  });

  it('spends the budget normally while VISIBLE on the same clock', async () => {
    const fake = fakeEmbed({ pages: PAGES, withProject: false });
    let clock = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 15000,
      settleMs: 50,
      now: () => clock,
      visibility: () => 'visible',
      sleep: async () => { clock += 1000; },
    });
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    const host = document.createElement('div');
    await c.mount(host, project({ 'main.kicad_sch': 's' }));
    expect(states).toEqual(['loading', 'timeout']);
    expect(clock).toBe(15000);
    expect(host.childElementCount).toBe(0);
  });

  it('a superseded mount goes quiet: one ready, and it never tears down the live embed', async () => {
    const stuck = fakeEmbed({ pages: PAGES, withProject: false });
    const live = fakeEmbed({ pages: PAGES });
    let nextEmbed: HTMLElement = stuck.embed;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => nextEmbed,
      readyMs: 60,
      settleMs: 10,
      sleep: async () => undefined,
    });
    const states: string[] = [];
    c.on('state', (e) => states.push(e.state));
    const host = document.createElement('div');
    const p = project({ 'main.kicad_sch': 's' });
    const first = c.mount(host, p);
    nextEmbed = live.embed;
    const second = c.mount(host, p);
    await Promise.all([first, second]);
    expect(states.filter((s) => s === 'ready')).toEqual(['ready']);
    expect(states).not.toContain('timeout');
    expect(host.firstElementChild).toBe(live.embed);
  });

  it('zooms through the viewer camera when it exists and reports false when it does not', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const v = fake.viewer as typeof fake.viewer & { zoom_to_page?: () => void; draw?: () => void; viewport?: { camera: { zoom: number } } };
    let fitted = 0;
    let drawn = 0;
    v.zoom_to_page = () => fitted++;
    // The repaint after a camera move is the VIEWER's draw(); Viewport has none
    // (vendor viewers/base/viewport.ts). Asserted so a silent no-op cannot return.
    v.draw = () => drawn++;
    v.viewport = { camera: { zoom: 1 } };
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(await c.zoom('fit')).toBe(true);
    expect(fitted).toBe(1);
    expect(drawn).toBe(0); // zoom_to_page repaints itself (document-viewer.ts:133-136)
    expect(await c.zoom('in')).toBe(true);
    expect(v.viewport!.camera.zoom).toBeCloseTo(1.25);
    expect(drawn).toBe(1);
    expect(await c.zoom('out')).toBe(true);
    expect(v.viewport!.camera.zoom).toBeCloseTo(1);
    expect(drawn).toBe(2);
    delete v.viewport;
    expect(await c.zoom('in')).toBe(false);
  });

  it('clamps the camera to the same bounds upstream gives its own wheel handler', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const v = fake.viewer as typeof fake.viewer & { draw?: () => void; viewport?: { camera: { zoom: number } } };
    v.draw = () => undefined;
    v.viewport = { camera: { zoom: 1 } };
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    for (let i = 0; i < 30; i++) expect(await c.zoom('in')).toBe(true);
    expect(v.viewport!.camera.zoom).toBe(190); // enable_pan_and_zoom(0.5, 190), viewer.ts:80
    for (let i = 0; i < 60; i++) expect(await c.zoom('out')).toBe(true);
    expect(v.viewport!.camera.zoom).toBe(0.5);
  });

  it('refuses a sheet whose file was dropped rather than showing its basename twin', async () => {
    const pages: FakePage[] = [
      { type: 'schematic', filename: 'main.kicad_sch', sheet_path: '/r', project_path: 'main.kicad_sch' },
      { type: 'schematic', filename: 'reg.kicad_sch', sheet_path: '/r/x', project_path: 'reg.kicad_sch:/r/x' },
    ];
    const fake = fakeEmbed({ pages });
    const c = controller(fake);
    // y/reg.kicad_sch collides on basename with x/reg.kicad_sch and is dropped.
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'x/reg.kicad_sch': 't', 'y/reg.kicad_sch': 'u' }));
    expect(await c.activate('schematic', 'x/reg.kicad_sch')).toBe(true);
    expect(await c.activate('schematic', 'y/reg.kicad_sch')).toBe(false);
  });

  it('reports error when the module fails to load, and dispose is idempotent', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c = new KicanvasController({ loadModule: async () => { throw new Error('boom'); }, createEmbed: () => fake.embed });
    const states: { state: string; detail?: string }[] = [];
    c.on('state', (e) => states.push({ state: e.state, detail: e.detail }));
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(states[1]).toEqual({ state: 'error', detail: 'boom' });
    c.dispose();
    c.dispose();
  });

  it('a load that rejects after dispose() emits nothing', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c = new KicanvasController({
      loadModule: async () => { await Promise.resolve(); throw new Error('boom'); },
      createEmbed: () => fake.embed,
    });
    const pending = c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    c.dispose(); // lands while the import is still in flight
    // Registered AFTER dispose on purpose: clearing the handler map must not be what
    // hides the stray emit, or the two halves of this fix mask each other.
    const after: string[] = [];
    c.on('state', (e) => after.push(e.state));
    await pending;
    expect(after).toEqual([]);
  });

  it('dispose() drops the handlers', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c2 = controller(fake);
    const seen: string[] = [];
    c2.on('state', (e) => seen.push(e.state));
    c2.dispose();
    await c2.mount(document.createElement('div'), project({ 'main.kicad_sch': 's' }));
    expect(seen).toEqual([]); // dispose() cleared the handler map
  });
});
