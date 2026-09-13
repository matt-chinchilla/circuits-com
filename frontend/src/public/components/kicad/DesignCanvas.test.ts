// @vitest-environment happy-dom
// Covers the paths the /viewer playtest cannot reach cheaply: the no-webgl short
// circuit, the retry teardown, and unmount while mount() is still pending. No JSX
// (vitest only discovers *.test.ts here) and no testing-library — createRoot + act.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanvasController, CanvasStateName } from './canvasController';
import type { KicadProject } from '@public/services/kicad/types';
import DesignCanvas from './DesignCanvas';
import { resetWebgl2ProbeForTests } from './webgl';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project = { name: 'demo', files: new Map(), sheets: [] } as unknown as KicadProject;

/** Force the probe's answer: happy-dom's canvas has no real webgl2 context. */
function setWebgl(ok: boolean) {
  resetWebgl2ProbeForTests();
  HTMLCanvasElement.prototype.getContext = (() => (ok ? { getExtension: () => null } : null)) as never;
}

function fakeController(unrenderable?: string[]) {
  let handler: ((e: { type: 'state'; state: CanvasStateName }) => void) | null = null;
  const f = {
    disposed: 0,
    askedFor: null as KicadProject | null,
    emit: (state: CanvasStateName) => handler?.({ type: 'state', state }),
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
      zoom: async () => true,
      dispose: () => {
        f.disposed++;
      },
      on: (kind: string, h: unknown) => {
        if (kind === 'state') handler = h as typeof handler;
        return () => {
          handler = null;
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
