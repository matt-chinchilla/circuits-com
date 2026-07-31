// salesForcePhysics — spring interaction layer for the book-of-business graph.
//
// ECharts stays the RENDERER (graph series, layout:'none'); this module owns
// positions and velocities, driven by the rest geometry exported from
// salesForceOption (`SalesForceBuild.layout`):
//   - A HUB / SUMMARY sphere is draggable and STAYS where it is dropped (no
//     spring). While it moves, its leaves' targets follow it every frame, so
//     the cluster trails with a springy lag and re-settles around the drop.
//   - A LEAF may be grabbed and flailed, but on release it always springs back
//     to its designated shell position (hub + rest offset).
//   - prefers-reduced-motion: no springs — leaves move rigidly with a dragged
//     hub, and a released leaf snaps home instantly.
//
// Frame updates go through `setOption({series:[{animationDurationUpdate: 0,
// data}]}, {lazyUpdate: true, silent: true})` — the same data objects each
// frame, only x/y mutated. The React-side option keeps SALES_FORCE_MORPH_MS
// for the Demo expand/collapse morph; it is restored on settle, and a React
// option rebuild (notMerge) resets everything anyway — the host re-attaches
// physics after each rebuild.
//
// ── Loop discipline (csFx 2026-06-22 rules) ────────────────────────────────
// The rAF loop runs ONLY while (a) a drag is active, or (b) total kinetic
// energy + max target distance is above epsilon; then it cancels itself
// (handle null). `destroyed`, set in the dispose() returned to the host,
// makes every entry point a no-op after detach; dispose also cancels the rAF
// and removes every chart/zr listener. React strict-mode double-mount is safe:
// each attach owns its own state, dispose is idempotent, and attaching to an
// already-disposed chart returns an inert handle.

import type { EChartsType } from 'echarts/core';
import { SALES_FORCE_MORPH_MS, type SalesForceRestNode } from './salesForceOption';

// Spring constants, tuned per-frame at ~60fps for a lively but settling flail.
const SPRING_K = 0.022; // acceleration per unit displacement (frame⁻²)
const DAMPING = 0.16; // velocity bleed per frame
const STOP_KE = 0.02; // Σ|v|² below this…
const STOP_DIST = 0.5; // …and every leaf this close to target → loop stops
const DRAG_CLICK_PX = 4; // pointer travel beyond this = drag, not click

export interface SalesForcePhysicsHandle {
  /** True when the pointer gesture that produced the CURRENT click event
   *  actually travelled (> ~4px) — i.e. it was a drag. The host's click
   *  handler (Demo expand/collapse) must bail when this is set. */
  wasDragClick(): boolean;
  dispose(): void;
}

const INERT: SalesForcePhysicsHandle = {
  wasDragClick: () => false,
  dispose: () => {},
};

interface GraphNodeDatum {
  name?: string;
  x?: number;
  y?: number;
  [key: string]: unknown;
}

interface Body {
  node: GraphNodeDatum;
  kind: 'hub' | 'leaf' | 'summary';
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Leaf only: rest offset from its hub, and the hub body itself. */
  offX: number;
  offY: number;
  hub: Body | null;
}

export function attachSalesForcePhysics(
  chart: EChartsType,
  layout: readonly SalesForceRestNode[],
): SalesForcePhysicsHandle {
  if (!layout.length || chart.isDisposed()) return INERT;
  const zr = chart.getZr();
  if (!zr) return INERT;

  const reducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // The LIVE node data array: handed back to setOption every frame with only
  // x/y mutated, so all styling (spheres, labels, tooltips) rides along.
  const opt = chart.getOption() as { series?: Array<{ data?: GraphNodeDatum[] }> };
  const data = opt.series?.[0]?.data;
  if (!data?.length) return INERT;

  const datumByName = new Map<string, GraphNodeDatum>();
  for (const d of data) if (typeof d.name === 'string') datumByName.set(d.name, d);

  const bodies = new Map<string, Body>();
  for (const l of layout) {
    const node = datumByName.get(l.name);
    if (!node) continue;
    bodies.set(l.name, {
      node,
      kind: l.kind,
      x: l.rest.x,
      y: l.rest.y,
      vx: 0,
      vy: 0,
      offX: 0,
      offY: 0,
      hub: null,
    });
  }
  for (const l of layout) {
    if (l.kind !== 'leaf' || !l.hubName) continue;
    const leaf = bodies.get(l.name);
    const hub = bodies.get(l.hubName);
    if (!leaf || !hub) continue;
    leaf.hub = hub;
    leaf.offX = l.rest.x - hub.x; // hubs are at rest here — nothing moved yet
    leaf.offY = l.rest.y - hub.y;
  }
  const leaves = [...bodies.values()].filter((b) => b.kind === 'leaf');

  // Fixed ARENA bounds from the rest layout. Positions are clamped here so a
  // drag can never grow the data bbox without limit — unclamped, each frame's
  // setOption refits the view to the larger extents, which remaps the same
  // pointer pixel farther out in data space: a feedback loop that stretches
  // the graph "infinitely" (owner-reported). The finite space is a principle
  // of this chart; the clamp enforces it in data space.
  const ARENA_PAD = 90;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const l of layout) {
    minX = Math.min(minX, l.rest.x);
    maxX = Math.max(maxX, l.rest.x);
    minY = Math.min(minY, l.rest.y);
    maxY = Math.max(maxY, l.rest.y);
  }
  const clampX = (x: number) => Math.min(maxX + ARENA_PAD, Math.max(minX - ARENA_PAD, x));
  const clampY = (y: number) => Math.min(maxY + ARENA_PAD, Math.max(minY - ARENA_PAD, y));

  let destroyed = false;
  let rafId: number | null = null;
  let drag: { body: Body; grabDX: number; grabDY: number } | null = null;
  let downX = 0;
  let downY = 0;
  let moved = false;

  // Targets are clamped to the SAME arena as positions — a hub dropped at the
  // boundary would otherwise give its outer leaves targets OUTSIDE the clamp:
  // the pinned leaf's displacement never shrinks, step() stays "lively"
  // forever, and the rAF loop burns 60fps setOption calls indefinitely
  // (review finding, 2026-07-31). A clamped target is always reachable.
  const targetOf = (leaf: Body): [number, number] => [
    clampX((leaf.hub?.x ?? 0) + leaf.offX),
    clampY((leaf.hub?.y ?? 0) + leaf.offY),
  ];

  const toData = (px: number, py: number): [number, number] | null => {
    if (chart.isDisposed()) return null;
    const pt = chart.convertFromPixel({ seriesIndex: 0 }, [px, py]) as unknown;
    return Array.isArray(pt) && Number.isFinite(pt[0]) && Number.isFinite(pt[1])
      ? [pt[0], pt[1]]
      : null;
  };

  function render(): void {
    if (destroyed || chart.isDisposed()) return;
    for (const b of bodies.values()) {
      b.node.x = b.x;
      b.node.y = b.y;
    }
    chart.setOption(
      { series: [{ animationDurationUpdate: 0, data }] },
      { lazyUpdate: true, silent: true },
    );
  }

  /** One spring step. Returns whether the system is still lively. */
  function step(): boolean {
    let ke = 0;
    let maxDist = 0;
    for (const leaf of leaves) {
      const [tx, ty] = targetOf(leaf);
      if (drag?.body === leaf) {
        // Grabbed leaf follows the pointer (onZrMove); count its displacement
        // so the loop keeps running while it is held away from home.
        maxDist = Math.max(maxDist, Math.hypot(tx - leaf.x, ty - leaf.y));
        continue;
      }
      if (reducedMotion) {
        // Rigid: no springy lag — leaves ride their hub exactly.
        leaf.x = tx;
        leaf.y = ty;
        leaf.vx = 0;
        leaf.vy = 0;
        continue;
      }
      leaf.vx += SPRING_K * (tx - leaf.x) - DAMPING * leaf.vx;
      leaf.vy += SPRING_K * (ty - leaf.y) - DAMPING * leaf.vy;
      leaf.x = clampX(leaf.x + leaf.vx);
      leaf.y = clampY(leaf.y + leaf.vy);
      ke += leaf.vx * leaf.vx + leaf.vy * leaf.vy;
      maxDist = Math.max(maxDist, Math.hypot(tx - leaf.x, ty - leaf.y));
    }
    return ke > STOP_KE || maxDist > STOP_DIST;
  }

  function frame(): void {
    rafId = null;
    if (destroyed || chart.isDisposed()) return;
    const lively = step();
    if (drag || lively) {
      render();
      rafId = requestAnimationFrame(frame);
      return;
    }
    // Settled: land every leaf EXACTLY on its designed position, then stop —
    // and give the Demo expand/collapse morph its duration back.
    for (const leaf of leaves) {
      const [tx, ty] = targetOf(leaf);
      leaf.x = tx;
      leaf.y = ty;
      leaf.vx = 0;
      leaf.vy = 0;
    }
    render();
    chart.setOption(
      { series: [{ animationDurationUpdate: SALES_FORCE_MORPH_MS }] },
      { lazyUpdate: true, silent: true },
    );
  }

  function start(): void {
    if (destroyed || rafId != null) return;
    rafId = requestAnimationFrame(frame);
  }

  const onNodeDown = (params: unknown): void => {
    if (destroyed) return;
    const p = params as {
      dataType?: string;
      data?: { name?: string };
      event?: { offsetX: number; offsetY: number; event?: { button?: number } };
    };
    if (p.dataType === 'edge' || !p.event) return;
    // Left button / touch ONLY. A right-click's mouseup is swallowed by the
    // native context menu, which would leave `drag` stuck on (node glued to
    // the cursor + the rAF loop running with no gesture — the exact "loop
    // must stop when idle" rule). Touch events carry no button (undefined).
    const button = p.event.event?.button;
    if (typeof button === 'number' && button !== 0) return;
    const name = p.data?.name;
    if (typeof name !== 'string') return;
    const body = bodies.get(name);
    if (!body) return;
    const pt = toData(p.event.offsetX, p.event.offsetY);
    if (!pt) return;
    drag = { body, grabDX: body.x - pt[0], grabDY: body.y - pt[1] };
    downX = p.event.offsetX;
    downY = p.event.offsetY;
    moved = false;
    if (body.kind === 'leaf') {
      body.vx = 0;
      body.vy = 0;
    }
    // The tooltip fights a live drag (it chases the pointer over other
    // nodes) — hide and disable it until release.
    chart.dispatchAction({ type: 'hideTip' });
    chart.setOption({ tooltip: { show: false } }, { lazyUpdate: true, silent: true });
    zr.setCursorStyle('grabbing');
    start();
  };

  const onZrMove = (e: { offsetX: number; offsetY: number }): void => {
    if (destroyed || !drag) return;
    if (!moved && Math.hypot(e.offsetX - downX, e.offsetY - downY) > DRAG_CLICK_PX) {
      moved = true;
    }
    const pt = toData(e.offsetX, e.offsetY);
    if (!pt) return;
    drag.body.x = clampX(pt[0] + drag.grabDX);
    drag.body.y = clampY(pt[1] + drag.grabDY);
    zr.setCursorStyle('grabbing');
    start();
  };

  const endDrag = (): void => {
    if (destroyed || !drag) return;
    const released = drag.body;
    drag = null; // hubs/summaries stay where dropped; leaves spring home
    if (released.kind === 'leaf' && reducedMotion) {
      const [tx, ty] = targetOf(released);
      released.x = tx;
      released.y = ty;
    }
    if (!chart.isDisposed()) {
      chart.setOption({ tooltip: { show: true } }, { lazyUpdate: true, silent: true });
    }
    zr.setCursorStyle('default');
    start(); // let the loop run to settle (or make the final snap render)
  };

  chart.on('mousedown', { seriesIndex: 0 }, onNodeDown);
  zr.on('mousemove', onZrMove);
  zr.on('mouseup', endDrag);
  zr.on('globalout', endDrag);

  return {
    // `moved` survives mouseup on purpose: zrender's mouseup (ends the drag)
    // fires BEFORE the synthesized click, and the flag resets on the next
    // node mousedown — so the click born from a drag sees `true`.
    wasDragClick: () => moved,
    dispose: () => {
      if (destroyed) return;
      destroyed = true;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      drag = null;
      if (!chart.isDisposed()) {
        chart.off('mousedown', onNodeDown);
        const z = chart.getZr();
        if (z) {
          z.off('mousemove', onZrMove);
          z.off('mouseup', endDrag);
          z.off('globalout', endDrag);
        }
        // If detached mid-drag, don't leave the tooltip disabled.
        chart.setOption({ tooltip: { show: true } }, { lazyUpdate: true, silent: true });
      }
    },
  };
}
