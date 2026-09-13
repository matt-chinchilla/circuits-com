// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { KicadProject } from '@public/services/kicad/types';
import { KicanvasController, sourcesFor } from './kicanvasController';

interface FakePage { type: 'pcb' | 'schematic'; filename: string; sheet_path: string; project_path: string; document: { filename: string } }

/** ONE document object per FILE, exactly as upstream: `ProjectPage.document` is
 *  `file_by_name(filename)` (vendor kicanvas/project.ts:393-395), so two instance
 *  pages of one file hand the viewer the SAME object — which is why upstream's
 *  `DocumentViewer.load` early-returns and dispatches nothing for that switch. */
const DOCS = new Map<string, { filename: string }>();
function docFor(filename: string): { filename: string } {
  let doc = DOCS.get(filename);
  if (doc == null) {
    doc = { filename };
    DOCS.set(filename, doc);
  }
  return doc;
}

/** `KiCanvasLoadEvent.type` — vendor viewers/base/events.ts:13-14. */
const LOAD = 'kicanvas:load';

function project(files: Record<string, string>, extra: Partial<KicadProject> = {}): KicadProject {
  const map = new Map(Object.entries(files));
  const sheets = [...map.keys()].filter((k) => k.endsWith('.kicad_sch')).map((path) => ({ path, uuid: `u-${path}`, text: map.get(path) as string }));
  return { name: 'p', files: map, pro: null, root: sheets[0]?.path ?? null, sheets, board: [...map.keys()].find((k) => k.endsWith('.kicad_pcb')) ?? null, warnings: [], missingSheets: [], formatVersions: {}, ...extra };
}

function makeViewer(selectedFor: string[], log: string[]) {
  return Object.assign(new EventTarget(), {
    document: null as { filename: string } | null,
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
  /** Dispatch the load on a later turn, to prove activate() waits for it. */
  asyncLoad?: boolean;
  /** Queue loads in `pending` for the test to fire by hand. */
  manualLoad?: boolean;
  /** App elements with no viewer at all — the pre-render state. */
  noViewer?: boolean;
  onLoad?: (projectPath: string) => void;
}) {
  const embed = document.createElement('kicanvas-embed');
  const shadow = embed.attachShadow({ mode: 'open' });
  let active: FakePage | null = null;
  const selected: string[] = [];
  const boardSelected: string[] = [];
  const pending: (() => void)[] = [];
  const mode = { manual: opts.manualLoad ?? false, deferred: false };
  const viewer = makeViewer(opts.selectedFor ?? [], selected);
  const boardViewer = makeViewer(opts.boardSelectedFor ?? [], boardSelected);
  const proj = {
    pages: () => opts.pages,
    get active_page() { return active; },
    // Mirrors upstream exactly: project.ts:274 assigns the FIRST page
    // unconditionally, so on a board-bearing project this is the PCB.
    root_schematic_page: opts.pages[0] ?? null,
    set_active_page(p: FakePage | string) {
      active = typeof p === 'string' ? (opts.pages.find((x) => x.project_path === p) ?? null) : p;
      const page = active;
      if (page == null || opts.viewerDoc === false) return;
      // kc-board-app loads pcb pages, kc-schematic-app loads schematics.
      const target = page.type === 'pcb' ? boardViewer : viewer;
      // Upstream's early return: the viewer already holds this document, so it
      // returns BEFORE resolve_loaded and no `kicanvas:load` is ever dispatched
      // (viewers/base/document-viewer.ts:58-60, viewers/base/viewer.ts:128-132).
      if (target.document === page.document) return;
      // The document is assigned when the load STARTS (document-viewer.ts:64); the event
      // comes only from resolve_loaded, inside the later() tail that positions the camera
      // and clears the selection (:68-86). Modelling that GAP is what lets a test see a
      // second activate for this page find the document "already held" mid-load.
      target.document = page.document;
      const fire = () => {
        opts.onLoad?.(page.project_path);
        target.dispatchEvent(new Event(LOAD));
      };
      // A macrotask, deliberately: a microtask would land before activate()'s own
      // continuation regardless of whether it waited, faking the proof below.
      if (mode.manual) pending.push(fire);
      else if (mode.deferred) setTimeout(fire, 0);
      else fire();
    },
  };
  const sch = document.createElement('kc-schematic-app') as HTMLElement & { project?: unknown; viewer?: unknown };
  if (opts.withProject !== false) sch.project = proj;
  if (!opts.noViewer) sch.viewer = viewer;
  shadow.appendChild(sch);
  const board = document.createElement('kc-board-app') as HTMLElement & { project?: unknown; viewer?: unknown };
  if (opts.withProject !== false) board.project = proj;
  if (!opts.noViewer) board.viewer = boardViewer;
  shadow.appendChild(board);
  // The real embed sets an active page after load; the fake does it immediately — and
  // always synchronously, so an asyncLoad fixture cannot drop the CONSTRUCTOR's own load
  // event into the middle of a later assertion.
  proj.set_active_page(proj.root_schematic_page ?? opts.pages[0]!);
  mode.deferred = opts.asyncLoad ?? false;
  return {
    embed, selected, boardSelected, getActive: () => active, viewer, boardViewer, proj, sch, board, pending,
    setManual: (v: boolean) => { mode.manual = v; },
  };
}

const PAGES: FakePage[] = [
  { type: 'schematic', filename: 'main.kicad_sch', sheet_path: '/r', project_path: 'main.kicad_sch', document: docFor('main.kicad_sch') },
  { type: 'schematic', filename: 'sub.kicad_sch', sheet_path: '/r/a', project_path: 'sub.kicad_sch:/r/a', document: docFor('sub.kicad_sch') },
  { type: 'schematic', filename: 'sub.kicad_sch', sheet_path: '/r/b', project_path: 'sub.kicad_sch:/r/b', document: docFor('sub.kicad_sch') },
  { type: 'pcb', filename: 'main.kicad_pcb', sheet_path: '', project_path: 'main.kicad_pcb', document: docFor('main.kicad_pcb') },
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

  it('waits for the viewer load event when the document really changes', async () => {
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
    // main.kicad_sch -> sub.kicad_sch is a genuine load, so the caller must not be
    // told the switch happened until the viewer says it did.
    await c.activate('schematic', '/r/a');
    order.push('activated:/r/a');
    expect(order).toEqual(['load:sub.kicad_sch:/r/a', 'activated:/r/a']);
  });

  it('settles at once when the viewer already holds the page document, because no event is coming', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    let clock = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 5000,
      settleMs: 1500,
      now: () => clock,
      sleep: async () => { clock += 1000; }, // any wait at all shows up in the clock
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    expect(await c.activate('schematic', '/r/a')).toBe(true);
    const before = clock;
    // Same FILE, so the same shared document object: DocumentViewer.load early-returns
    // before resolve_loaded and dispatches nothing. Waiting would burn the whole
    // settleMs on what upstream treats as a no-op — and this is the common gesture
    // (a revisited sheet, a second focusRef, mount's closing activate).
    expect(await c.activate('schematic', '/r/b')).toBe(true);
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/b');
    expect(clock).toBe(before);
  });

  it('never short-circuits past its OWN in-flight load, however fast the second activate is', async () => {
    // The other half of the same coin. Upstream assigns `this.document = src` when the
    // load STARTS (vendor viewers/base/document-viewer.ts:64) and only positions the
    // camera, dispatches kicanvas:load and CLEARS THE SELECTION afterwards, in the
    // later() tail (:68-86). So holdsDocument() is already true while a load is running:
    // a second activate that short-circuited there would resolve with nothing positioned,
    // and the focusRef awaiting it would report 'focused' just before the tail deselects.
    const fake = fakeEmbed({ pages: PAGES, asyncLoad: true });
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 500,
      settleMs: 500,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    const order: string[] = [];
    fake.viewer.addEventListener(LOAD, () => order.push('load'));
    const first = c.activate('schematic', '/r/a'); // a real load: the document changes
    const second = c.activate('schematic', '/r/a'); // same page, its document is already assigned
    expect(await second).toBe(true);
    order.push('second');
    expect(await first).toBe(false); // superseded, so it writes no `hidden` of its own
    expect(order).toEqual(['load', 'second']);
  });

  it('retires a watch that outlived its budget, so the next activate for that page is not charged twice', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    let clock = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 5000,
      settleMs: 1500,
      now: () => clock,
      sleep: async () => { clock += 500; },
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    fake.setManual(true); // the load is queued and never fired — the budget runs out
    expect(await c.activate('schematic', '/r/a')).toBe(true);
    expect(clock).toBe(1500);
    // The viewer HOLDS that document now (upstream assigns it when the load starts), and a
    // watch that never fired is no longer evidence of a load in flight — riding it would
    // spend the whole budget a second time on the same page. The first switch into a
    // hidden app times out exactly like this: its canvas is 0x0 until it is shown.
    expect(await c.activate('schematic', '/r/b')).toBe(true);
    expect(clock).toBe(1500);
  });

  it('does not wait when there is no viewer to signal it — nothing is coming', async () => {
    // `Viewer extends EventTarget` (vendor viewers/base/viewer.ts:22), so an
    // unlistenable watch means the app has not rendered its viewer yet, not that the
    // renderer lacks the event. Either way no load signal can arrive, so waiting for
    // one would just spend the settle budget.
    const fake = fakeEmbed({ pages: PAGES, noViewer: true });
    let clock = 0;
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 5000,
      settleMs: 1500,
      now: () => clock,
      sleep: async () => { clock += 1000; },
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    const before = clock;
    expect(await c.activate('schematic', '/r/a')).toBe(true);
    expect(clock).toBe(before);
  });

  it('a superseded activate never writes hidden: the newer switch wins and the older returns false', async () => {
    const fake = fakeEmbed({ pages: PAGES });
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 500,
      settleMs: 1000,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't', 'main.kicad_pcb': 'b' }));
    fake.setManual(true); // from here the test decides when each load lands
    const first = c.activate('board');
    const second = c.activate('schematic', '/r/a');
    fake.pending[1]!(); // the schematic loads first, so the SECOND switch completes first
    expect(await second).toBe(true);
    expect([fake.sch.hidden, fake.board.hidden]).toEqual([false, true]);
    fake.pending[0]!(); // the board's load arrives late, after it was superseded
    expect(await first).toBe(false);
    expect([fake.sch.hidden, fake.board.hidden]).toEqual([false, true]); // view untouched
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

  /**
   * A focus and a HOST activate racing for the same view.
   *
   * This is not hypothetical: `/viewer` names the designator's own sheet in page
   * state before it calls focusRef (so the chip bar and the drawing agree), and
   * that state change makes DesignCanvas's activate effect fire on the very
   * commit focusRef is awaiting inside. The second activate bumps `activation`,
   * so focusRef's own activate loses the `seq` guard and returns false — and a
   * SUPERSEDED activate is not the same answer as a missing page. Answering
   * 'not-found' there tells the reader a reference that is on screen does not
   * exist.
   */
  it('still focuses when a host activate overtakes it onto the SAME sheet', async () => {
    const fake = fakeEmbed({ pages: PAGES, selectedFor: ['U1'], asyncLoad: true });
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 500,
      settleMs: 500,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));

    // The page's two calls, in the order the page makes them: focusRef by
    // INSTANCE path, then the host effect by FILE path — the same document.
    const focus = c.focusRef('U1', '/r/a');
    const host = c.activate('schematic', 'sub.kicad_sch');

    expect(await focus).toBe('focused');
    expect(await host).toBe(true);
    expect(fake.selected).toEqual(['U1']);
    expect(fake.viewer.selected).toBe('U1');
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/a');
  });

  it('takes the view back when a host activate overtakes it onto a DIFFERENT sheet', async () => {
    const fake = fakeEmbed({ pages: PAGES, selectedFor: ['U1'], asyncLoad: true });
    const c = new KicanvasController({
      loadModule: async () => undefined,
      createEmbed: () => fake.embed,
      readyMs: 500,
      settleMs: 500,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));

    // The stale-activeSheet shape: the host is still asking for the root while
    // the focus wants a sub-sheet. The focus is the user's gesture and wins.
    const focus = c.focusRef('U1', '/r/a');
    const host = c.activate('schematic', 'main.kicad_sch');

    expect(await focus).toBe('focused');
    void (await host);
    expect(fake.viewer.selected).toBe('U1');
    expect(fake.getActive()?.project_path).toBe('sub.kicad_sch:/r/a');
  });

  it('still answers not-found for a sheet that is genuinely not there', async () => {
    const fake = fakeEmbed({ pages: PAGES, selectedFor: ['U1'] });
    const c = controller(fake);
    await c.mount(document.createElement('div'), project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't' }));
    // No page carries this name, so no amount of re-waiting can produce one —
    // the retry must not turn a real miss into a focus on whatever is on screen.
    expect(await c.focusRef('U1', 'nowhere.kicad_sch')).toBe('not-found');
    expect(fake.selected).toEqual([]);
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

  it('an activate superseded by a REMOUNT returns false and leaves the view it captured alone', async () => {
    const first = fakeEmbed({ pages: PAGES });
    const live = fakeEmbed({ pages: PAGES });
    let nextEmbed: HTMLElement = first.embed;
    let release: () => void = () => undefined;
    // The second mount parks on its module load, so it never starts an activate of its
    // own: `seq` stays current and ONLY the epoch half of the guard can catch this one.
    const parked = new Promise<void>((resolve) => { release = () => resolve(); });
    let loads = 0;
    const c = new KicanvasController({
      loadModule: async () => { if (++loads === 2) await parked; },
      createEmbed: () => nextEmbed,
      readyMs: 500,
      settleMs: 40,
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    const host = document.createElement('div');
    const p = project({ 'main.kicad_sch': 's', 'sub.kicad_sch': 't', 'main.kicad_pcb': 'b' });
    await c.mount(host, p);
    expect([first.sch.hidden, first.board.hidden]).toEqual([false, true]);
    first.setManual(true); // the board's load never lands, so the activate is still settling
    const activating = c.activate('board');
    nextEmbed = live.embed;
    const remount = c.mount(host, p); // supersedes that mount mid-settle
    expect(await activating).toBe(false);
    expect([first.sch.hidden, first.board.hidden]).toEqual([false, true]); // never flipped to the board
    release();
    await remount;
    expect(host.firstElementChild).toBe(live.embed);
    expect([live.sch.hidden, live.board.hidden]).toEqual([false, true]);
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
      { type: 'schematic', filename: 'main.kicad_sch', sheet_path: '/r', project_path: 'main.kicad_sch', document: docFor('main.kicad_sch') },
      { type: 'schematic', filename: 'reg.kicad_sch', sheet_path: '/r/x', project_path: 'reg.kicad_sch:/r/x', document: docFor('reg.kicad_sch') },
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
