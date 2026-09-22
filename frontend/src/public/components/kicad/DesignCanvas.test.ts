// @vitest-environment happy-dom
// Covers the paths the /viewer playtest cannot reach cheaply: the no-webgl short
// circuit, the retry teardown, and unmount while mount() is still pending. No JSX
// (vitest only discovers *.test.ts here) and no testing-library — createRoot + act.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasController, CanvasStateName, LayerInfo } from './canvasController';
import type { KicadProject } from '@public/services/kicad/types';
import DesignCanvas, { type DesignCanvasHandle } from './DesignCanvas';
import { resetWebgl2ProbeForTests } from './webgl';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LAYER: LayerInfo = { name: 'F.Cu', kind: 'copper', side: 'F', color: 'rgba(200, 52, 52, 1)', visible: true, highlighted: false };

const project = { name: 'demo', files: new Map(), sheets: [] } as unknown as KicadProject;

/** Force the probe's answer: happy-dom's canvas has no real webgl2 context. */
function setWebgl(ok: boolean) {
  resetWebgl2ProbeForTests();
  HTMLCanvasElement.prototype.getContext = (() => (ok ? { getExtension: () => null } : null)) as never;
}

function fakeController(unrenderable?: string[]) {
  let handler: ((e: { type: 'state'; state: CanvasStateName }) => void) | null = null;
  let selection: ((e: { type: 'selection'; ref: string | null; sheet?: string; view?: 'schematic' | 'board' }) => void) | null = null;
  const f = {
    disposed: 0,
    askedFor: null as KicadProject | null,
    selected: [] as (string | null)[],
    emit: (state: CanvasStateName) => handler?.({ type: 'state', state }),
    pick: (ref: string | null) => selection?.({ type: 'selection', ref, sheet: '/r', view: 'schematic' }),
    // Never resolves: every case here unmounts or retries while mount() is in flight.
    ctrl: {
      // Optional on the protocol: a renderer that drops nothing does not
      // implement it, and `undefined` here is how that case is exercised.
      ...(unrenderable == null
        ? {}
        : {
            unrenderableSheets: (p: KicadProject) => {
              f.askedFor = p;
              return unrenderable;
            },
          }),
      mount: () => new Promise<void>(() => {}),
      activate: async () => true,
      focusRef: async () => 'focused' as const,
      selectRef: async (ref: string | null) => {
        f.selected.push(ref);
        return 'focused' as const;
      },
      zoom: async () => true,
      dispose: () => {
        f.disposed++;
      },
      on: (kind: string, h: unknown) => {
        if (kind === 'state') handler = h as typeof handler;
        if (kind === 'selection') selection = h as typeof selection;
        return () => {
          if (kind === 'state') handler = null;
          if (kind === 'selection') selection = null;
        };
      },
    } as unknown as CanvasController,
  };
  return f;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  vi.restoreAllMocks();
  container.remove();
});

describe('DesignCanvas', () => {
  it('shows the no-webgl card and never builds a controller', async () => {
    setWebgl(false);
    let built = 0;
    const seen: CanvasStateName[] = [];
    await act(async () => {
      root.render(
        createElement(DesignCanvas, {
          project,
          view: 'schematic',
          onState: (s: CanvasStateName) => seen.push(s),
          createController: () => {
            built++;
            return fakeController().ctrl;
          },
        }),
      );
    });
    expect(container.textContent).toContain('WebGL disabled');
    expect(built).toBe(0);
    expect(seen).toEqual(['no-webgl']);
    await act(async () => root.unmount());
  });

  it('disposes the controller and builds a fresh one when retry is clicked', async () => {
    setWebgl(true);
    const made: ReturnType<typeof fakeController>[] = [];
    await act(async () => {
      root.render(
        createElement(DesignCanvas, {
          project,
          view: 'schematic',
          createController: () => {
            const f = fakeController();
            made.push(f);
            return f.ctrl;
          },
        }),
      );
    });
    expect(made).toHaveLength(1);
    await act(async () => made[0].emit('timeout'));
    // Only the retry renders in this state — the zoom cluster is ready-only.
    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('Try again');
    await act(async () => retry?.click());
    expect(made[0].disposed).toBe(1);
    expect(made).toHaveLength(2);
    await act(async () => root.unmount());
  });

  it('calls the CURRENT onState, not the one captured when it mounted', async () => {
    setWebgl(true);
    const f = fakeController();
    const first: CanvasStateName[] = [];
    const second: CanvasStateName[] = [];
    const render = (onState: (s: CanvasStateName) => void) =>
      root.render(createElement(DesignCanvas, { project, view: 'schematic', onState, createController: () => f.ctrl }));
    await act(async () => render((s) => first.push(s)));
    // Same `project` identity, so this re-renders WITHOUT remounting the controller.
    await act(async () => render((s) => second.push(s)));
    await act(async () => f.emit('ready'));
    expect(second).toEqual(['ready']);
    expect(first).toEqual([]);
    await act(async () => root.unmount());
  });

  it('hands the controller\u2019s selection to the CURRENT onSelection, and selectRef through the handle', async () => {
    setWebgl(true);
    const f = fakeController();
    const seen: (string | null)[] = [];
    const handle: { current: { selectRef: (r: string | null) => Promise<string> } | null } = { current: null };
    const render = (onSelection: (s: { ref: string | null }) => void) =>
      root.render(
        createElement(DesignCanvas, { ref: handle, project, view: 'schematic', onSelection, createController: () => f.ctrl }),
      );
    await act(async () => render(() => seen.push('stale')));
    // Same `project` identity: a new inline arrow must not remount the embed.
    await act(async () => render((s) => seen.push(s.ref)));
    await act(async () => f.emit('ready'));
    await act(async () => f.pick('U1'));
    await act(async () => f.pick(null));
    expect(seen).toEqual(['U1', null]);
    expect(f.disposed).toBe(0);
    await act(async () => {
      await handle.current?.selectRef(null);
    });
    expect(f.selected).toEqual([null]);
    await act(async () => root.unmount());
  });

  it('forwards every board control through the handle and the layers event to the CURRENT onLayers', async () => {
    setWebgl(true);
    const f = fakeController();
    const calls: string[] = [];
    let layersHandler: ((e: { type: 'layers'; layers: LayerInfo[] }) => void) | null = null;
    const on = f.ctrl.on.bind(f.ctrl);
    const ctrl = Object.assign(f.ctrl, {
      layers: () => [LAYER],
      setLayerVisible: (name: string, visible: boolean) => calls.push(`visible:${name}:${visible}`),
      highlightLayer: (name: string | null) => calls.push(`layer:${name}`),
      setObjectOpacity: (kind: string, opacity: number) => calls.push(`opacity:${kind}:${opacity}`),
      nets: () => [{ number: 3, name: 'SDA' }],
      highlightNet: (net: number | null) => calls.push(`net:${net}`),
      on: (kind: string, h: unknown) => {
        if (kind !== 'layers') return on(kind as 'state', h as never);
        layersHandler = h as typeof layersHandler;
        return () => {
          layersHandler = null;
        };
      },
    }) as CanvasController;
    const handle: { current: DesignCanvasHandle | null } = { current: null };
    const seen: string[] = [];
    const render = (onLayers: (layers: LayerInfo[]) => void) =>
      root.render(createElement(DesignCanvas, { ref: handle, project, view: 'board', onLayers, createController: () => ctrl }));
    await act(async () => render(() => seen.push('stale')));
    // A new inline arrow must not remount the embed — and must be the one called.
    await act(async () => render((layers) => seen.push(layers.map((l) => l.name).join(','))));
    await act(async () => layersHandler?.({ type: 'layers', layers: [LAYER] }));
    expect(seen).toEqual(['F.Cu']);
    expect(f.disposed).toBe(0);

    const h = handle.current!;
    expect(h.hasBoardControls()).toBe(true);
    expect(h.layers()).toEqual([LAYER]);
    expect(h.nets()).toEqual([{ number: 3, name: 'SDA' }]);
    h.setLayerVisible('B.Cu', false);
    h.highlightLayer('F.Cu');
    h.highlightLayer(null);
    h.setObjectOpacity('zones', 0.4);
    h.highlightNet(3);
    h.highlightNet(null);
    expect(calls).toEqual(['visible:B.Cu:false', 'layer:F.Cu', 'layer:null', 'opacity:zones:0.4', 'net:3', 'net:null']);

    // The handle keeps its identity across renders, and after unmount the
    // controller is gone: every member answers empty and does nothing.
    await act(async () => root.unmount());
    expect(layersHandler).toBeNull();
    expect(h.hasBoardControls()).toBe(false);
    expect(h.layers()).toEqual([]);
    expect(h.nets()).toEqual([]);
    expect(() => h.setLayerVisible('F.Cu', true)).not.toThrow();
    expect(calls).toHaveLength(6);
  });

  it('answers "no board controls" for a renderer that does not implement them', async () => {
    setWebgl(true);
    const f = fakeController();
    const handle: { current: DesignCanvasHandle | null } = { current: null };
    await act(async () => {
      root.render(createElement(DesignCanvas, { ref: handle, project, view: 'board', createController: () => f.ctrl }));
    });
    const h = handle.current!;
    expect(h.hasBoardControls()).toBe(false);
    expect(h.layers()).toEqual([]);
    expect(h.nets()).toEqual([]);
    expect(() => {
      h.setLayerVisible('F.Cu', false);
      h.highlightLayer('F.Cu');
      h.setObjectOpacity('tracks', 0);
      h.highlightNet(1);
    }).not.toThrow();
    await act(async () => root.unmount());
  });

  it('renders the no-webgl card when the browser THROWS from getContext', async () => {
    resetWebgl2ProbeForTests();
    HTMLCanvasElement.prototype.getContext = (() => {
      throw new Error('blocked by a fingerprint guard');
    }) as never;
    await act(async () => {
      root.render(createElement(DesignCanvas, { project, view: 'schematic' }));
    });
    expect(container.textContent).toContain('WebGL disabled');
    await act(async () => root.unmount());
  });

  it('disposes on unmount while mount() is pending, with no late state update', async () => {
    setWebgl(true);
    const errors: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a);
    });
    const f = fakeController();
    await act(async () => {
      root.render(createElement(DesignCanvas, { project, view: 'schematic', createController: () => f.ctrl }));
    });
    await act(async () => root.unmount());
    expect(f.disposed).toBe(1);
    // The controller detached its handler, so a late event reaches no setState.
    await act(async () => f.emit('ready'));
    expect(errors).toEqual([]);
  });

  /**
   * The seam that keeps renderer-specific limits out of the pages: which sheets
   * cannot be drawn is the mounted CONTROLLER's answer, and the host reports it
   * before `mount()` — which is where the renderer bundle is fetched and
   * awaited — so a host can mark them on the commit that first paints them
   * rather than a frame later.
   */
  it('reports the controller\u2019s unrenderable sheets before the canvas is ready', async () => {
    setWebgl(true);
    const f = fakeController(['alt/power.kicad_sch']);
    const reported: string[][] = [];
    const seen: CanvasStateName[] = [];
    await act(async () => {
      root.render(
        createElement(DesignCanvas, {
          project,
          view: 'schematic',
          onState: (s: CanvasStateName) => seen.push(s),
          onUnrenderableSheets: (paths: string[]) => reported.push(paths),
          createController: () => f.ctrl,
        }),
      );
    });
    expect(reported).toEqual([['alt/power.kicad_sch']]);
    // mount() never resolves in this fake, so nothing has reached `ready` — the
    // answer did not wait for the renderer.
    expect(seen).toEqual([]);
    expect(f.askedFor).toBe(project);
    await act(async () => root.unmount());
  });

  it('reports an empty list for a renderer that answers none, and with no WebGL at all', async () => {
    setWebgl(true);
    const reported: string[][] = [];
    const props = (createController: () => never) => ({
      project,
      view: 'schematic' as const,
      onUnrenderableSheets: (paths: string[]) => reported.push(paths),
      createController,
    });
    // A controller that does not implement the optional member: "none", never
    // "unknown" — a host left uninformed would carry a stale set.
    await act(async () => {
      root.render(createElement(DesignCanvas, props(() => fakeController().ctrl as never)));
    });
    expect(reported).toEqual([[]]);
    await act(async () => root.unmount());

    setWebgl(false);
    root = createRoot(container);
    await act(async () => {
      root.render(createElement(DesignCanvas, props(() => fakeController(['x']).ctrl as never)));
    });
    expect(reported).toEqual([[], []]);
    await act(async () => root.unmount());
  });
});

describe('DesignCanvas — height', () => {
  /** The frame is the outermost element the component renders. */
  const frame = () => container.firstElementChild as HTMLElement;

  it('declares the compact rule the class name refers to', () => {
    // Vitest hands back CSS-module class names from a proxy that ECHOES THE KEY,
    // so `styles.frameCompact` is a truthy string in a test whether or not the
    // rule exists. The DOM assertion below therefore cannot see a renamed or
    // emptied rule — and an empty rule is precisely what makes a CSS-module
    // class `undefined` in the real build (house gotcha). The source is the
    // only witness available here.
    const scss = readFileSync(join(__dirname, 'DesignCanvas.module.scss'), 'utf8');
    const start = scss.indexOf('\n.frameCompact {');
    expect(start).toBeGreaterThan(-1);
    expect(scss.slice(start, scss.indexOf('\n}', start))).toMatch(/height:\s*45vh/);
  });

  it('takes the compact class only when asked, and never loses the base one', async () => {
    // Asserted on the REAL component, not a stub: the thing that can break
    // silently here is a CSS-Modules class resolving to `undefined` because the
    // rule was renamed or emptied (the standing house gotcha), and only reading
    // the rendered className catches that.
    setWebgl(true);
    await act(async () => {
      root.render(
        createElement(DesignCanvas, {
          project,
          view: 'schematic' as const,
          createController: (() => fakeController().ctrl) as never,
        }),
      );
    });
    const base = [...frame().classList];
    expect(base).toHaveLength(1);
    expect(base[0]).toBeTruthy();
    expect(base[0]).not.toContain('undefined');
    await act(async () => root.unmount());

    root = createRoot(container);
    await act(async () => {
      root.render(
        createElement(DesignCanvas, {
          project,
          view: 'schematic' as const,
          height: 'compact' as const,
          createController: (() => fakeController().ctrl) as never,
        }),
      );
    });
    const compact = [...frame().classList];
    expect(compact).toHaveLength(2);
    expect(compact[0]).toBe(base[0]);
    expect(compact[1]).toMatch(/frameCompact/);
    await act(async () => root.unmount());
  });
});
