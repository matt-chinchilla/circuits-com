// ChartMotion — tells every EChart beneath it whether a mount deserves an
// entry animation.
//
// A chart that mounts from CACHED, unchanged data (the operator came back to
// a page they already saw) should simply be there; replaying the draw-in
// every visit is the "charts re-animate every time" complaint (owner,
// 2026-09-03). Update animation is untouched: when a background refresh
// brings different data, the chart still morphs to it.
//
// A context rather than a prop so the eight dashboard panels need no plumbing
// — the page that owns the data sets it once.

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

const ChartMotionContext = createContext<boolean>(true);

export function ChartMotion({
  animateEntry,
  children,
}: {
  animateEntry: boolean;
  children: ReactNode;
}) {
  return <ChartMotionContext.Provider value={animateEntry}>{children}</ChartMotionContext.Provider>;
}

/** True (the default, outside any provider) = animate the first paint. */
export function useChartEntryAnimation(): boolean {
  return useContext(ChartMotionContext);
}
