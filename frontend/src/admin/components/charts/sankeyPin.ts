// sankeyPin — click a Sankey node or band to keep its flow lit.
//
// ECharts lights a node's trajectory on hover (`emphasis.focus:
// 'trajectory'`) and drops it on mouseout. A person reading the chart to
// someone else wants it to STAY: one click pins the highlight, a second
// click on the same target (or a click on empty canvas) releases it, and a
// click elsewhere moves it.
//
// Mechanics: a dispatched `highlight` puts the target in emphasis and blurs
// everything outside its focus set (the trajectory indices the view stored
// on the element), exactly like hover. But ECharts' own mouseout handler
// un-blurs the whole series whenever the pointer leaves ANY element, so the
// pin re-applies itself on every mouseout/globalout — one deferred tick, so
// it lands after the built-in leave handling of the same event.
//
// Installed per chart INSTANCE from EChart's `onReady`; the host must call
// `reset()` when it hands the chart a new option (`notMerge` rebuilds every
// element, so a stored dataIndex would point at whatever now sits there)
// and `uninstall()` when it lets go of the instance.

import type { EChartsType } from 'echarts/core';

export interface PinTarget {
  dataType: 'node' | 'edge';
  dataIndex: number;
}

export interface SankeyPin {
  /** Forget the pin without dispatching (the chart is being rebuilt). */
  reset(): void;
  /** Release the pin and unbind every listener. Safe after dispose. */
  uninstall(): void;
  /** What is pinned right now, for tests and callers that want to know. */
  current(): PinTarget | null;
}

type ClickParams = {
  componentType?: string;
  seriesIndex?: number;
  dataType?: string;
  dataIndex?: number;
};

export function installSankeyPin(chart: EChartsType, seriesIndex = 0): SankeyPin {
  let pinned: PinTarget | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const payload = (t: PinTarget) => ({
    seriesIndex,
    dataIndex: t.dataIndex,
    ...(t.dataType === 'edge' ? { dataType: 'edge' } : {}),
  });
  const apply = (t: PinTarget) => {
    if (!chart.isDisposed()) chart.dispatchAction({ type: 'highlight', ...payload(t) });
  };
  const release = () => {
    if (pinned && !chart.isDisposed()) chart.dispatchAction({ type: 'downplay', ...payload(pinned) });
    pinned = null;
  };
  const forget = () => {
    pinned = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const onClick = (raw: unknown) => {
    const p = (raw ?? {}) as ClickParams;
    if (p.componentType !== 'series' || p.seriesIndex !== seriesIndex || p.dataIndex == null) return;
    const next: PinTarget = { dataType: p.dataType === 'edge' ? 'edge' : 'node', dataIndex: p.dataIndex };
    const same = pinned !== null && pinned.dataType === next.dataType && pinned.dataIndex === next.dataIndex;
    release();
    if (same) return;
    pinned = next;
    apply(next);
  };
  const onLeave = () => {
    if (!pinned) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (pinned) apply(pinned);
    }, 0);
  };
  // zrender sees the raw canvas click; no `target` means empty space.
  const zr = chart.getZr();
  const onCanvasClick = (e: unknown) => {
    if (!(e as { target?: unknown } | undefined)?.target) release();
  };

  chart.on('click', onClick);
  chart.on('mouseout', onLeave);
  chart.on('globalout', onLeave);
  zr.on('click', onCanvasClick);

  return {
    reset: forget,
    uninstall() {
      forget();
      if (chart.isDisposed()) return;
      chart.off('click', onClick);
      chart.off('mouseout', onLeave);
      chart.off('globalout', onLeave);
      zr.off('click', onCanvasClick);
    },
    current: () => pinned,
  };
}
