import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EChartsType } from 'echarts/core';
import { installSankeyPin } from './sankeyPin';

type Handler = (p?: unknown) => void;

function fakeChart() {
  const handlers = new Map<string, Handler[]>();
  const zrHandlers = new Map<string, Handler[]>();
  const actions: Array<Record<string, unknown>> = [];
  let disposed = false;
  const add = (m: Map<string, Handler[]>) => (name: string, h: Handler) => {
    m.set(name, [...(m.get(name) ?? []), h]);
  };
  const remove = (m: Map<string, Handler[]>) => (name: string, h: Handler) => {
    m.set(name, (m.get(name) ?? []).filter((x) => x !== h));
  };
  const chart = {
    on: add(handlers),
    off: remove(handlers),
    dispatchAction: (a: Record<string, unknown>) => {
      actions.push(a);
    },
    getZr: () => ({ on: add(zrHandlers), off: remove(zrHandlers) }),
    isDisposed: () => disposed,
  } as unknown as EChartsType;
  const fire = (name: string, p?: unknown) => (handlers.get(name) ?? []).forEach((h) => h(p));
  const fireZr = (name: string, p?: unknown) => (zrHandlers.get(name) ?? []).forEach((h) => h(p));
  return { chart, actions, fire, fireZr, dispose: () => (disposed = true), handlers, zrHandlers };
}

const node = (dataIndex: number) => ({ componentType: 'series', seriesIndex: 0, dataType: 'node', dataIndex });
const edge = (dataIndex: number) => ({ componentType: 'series', seriesIndex: 0, dataType: 'edge', dataIndex });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('installSankeyPin', () => {
  it('pins a node on click and releases it on a second click', () => {
    const f = fakeChart();
    const pin = installSankeyPin(f.chart);
    f.fire('click', node(3));
    expect(pin.current()).toEqual({ dataType: 'node', dataIndex: 3 });
    expect(f.actions).toEqual([{ type: 'highlight', seriesIndex: 0, dataIndex: 3 }]);
    f.fire('click', node(3));
    expect(pin.current()).toBeNull();
    expect(f.actions.at(-1)).toEqual({ type: 'downplay', seriesIndex: 0, dataIndex: 3 });
  });

  it('moves the pin: the old target is downplayed before the new one lights', () => {
    const f = fakeChart();
    installSankeyPin(f.chart);
    f.fire('click', node(1));
    f.fire('click', edge(7));
    expect(f.actions.slice(1)).toEqual([
      { type: 'downplay', seriesIndex: 0, dataIndex: 1 },
      { type: 'highlight', seriesIndex: 0, dataIndex: 7, dataType: 'edge' },
    ]);
  });

  it('re-applies the pin after the pointer leaves, one tick later', () => {
    const f = fakeChart();
    installSankeyPin(f.chart);
    f.fire('click', node(2));
    f.fire('mouseout');
    f.fire('globalout');
    expect(f.actions).toHaveLength(1); // nothing yet — it waits for the built-in leave handling
    vi.runAllTimers();
    expect(f.actions).toHaveLength(2); // coalesced into ONE re-highlight
    expect(f.actions[1]).toEqual({ type: 'highlight', seriesIndex: 0, dataIndex: 2 });
  });

  it('does nothing on leave when nothing is pinned, and ignores non-series clicks', () => {
    const f = fakeChart();
    installSankeyPin(f.chart);
    f.fire('mouseout');
    vi.runAllTimers();
    f.fire('click', { componentType: 'graphic' });
    f.fire('click', { componentType: 'series', seriesIndex: 1, dataType: 'node', dataIndex: 0 });
    expect(f.actions).toEqual([]);
  });

  it('a click on empty canvas releases the pin', () => {
    const f = fakeChart();
    const pin = installSankeyPin(f.chart);
    f.fire('click', node(4));
    f.fireZr('click', { target: {} }); // a click ON an element does not release
    expect(pin.current()).not.toBeNull();
    f.fireZr('click', {});
    expect(pin.current()).toBeNull();
    expect(f.actions.at(-1)).toEqual({ type: 'downplay', seriesIndex: 0, dataIndex: 4 });
  });

  it('reset forgets without dispatching; uninstall unbinds and is safe after dispose', () => {
    const f = fakeChart();
    const pin = installSankeyPin(f.chart);
    f.fire('click', node(5));
    pin.reset();
    expect(pin.current()).toBeNull();
    expect(f.actions).toHaveLength(1);
    f.fire('mouseout');
    vi.runAllTimers();
    expect(f.actions).toHaveLength(1);
    pin.uninstall();
    expect(f.handlers.get('click')).toEqual([]);
    expect(f.zrHandlers.get('click')).toEqual([]);
    const g = fakeChart();
    const pin2 = installSankeyPin(g.chart);
    g.dispose();
    expect(() => pin2.uninstall()).not.toThrow();
  });
});
