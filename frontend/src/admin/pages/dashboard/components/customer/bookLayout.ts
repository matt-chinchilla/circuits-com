// Radial geometry for the customer's book of business.
//
// The staff board's cluster graph computes its positions and hands ECharts
// `layout: 'none'` — a force simulation cannot hold an even angular division,
// and ECharts' force layout mis-fits a bounded viewport (the 2026-07-30
// lane-anchor clipping). The customer's graph is the same treatment with one
// hub instead of several: their own company at the centre, every counterparty
// on a ring around it.
//
// Split out of the option builder because it is arithmetic — it unit-tests
// with no React, no DOM and no echarts.

/** Nodes per ring, hub outward. A ring's circumference grows with its radius,
 *  so its capacity does too. */
function ringCapacity(ring: number): number {
  return 10 + 6 * (ring - 1);
}

/** Ring radius in the graph's own coordinate space (ECharts fits the whole
 *  node bounding box into the series box, so these are relative, not pixels). */
function ringRadius(ring: number): number {
  return 130 + 96 * (ring - 1);
}

export interface BookPlacement {
  x: number;
  y: number;
  /** 1-based, hub outward. */
  ring: number;
}

/**
 * How many counterparties to draw before the ring pattern stops reading as a
 * shape. Three rings hold 48; past that the labels collide whatever the
 * geometry does, so the panel shows the top `BOOK_MAX_NODES` by parts count
 * and says so.
 */
export const BOOK_MAX_NODES = 40;

/**
 * Spread `n` nodes over as few rings as hold them, PROPORTIONALLY.
 *
 * Filling ring one to its capacity before starting ring two puts a lone node
 * on an otherwise empty outer orbit for n = 11, which reads as a mistake. The
 * proportional split (largest remainder, inner rings first) keeps every ring
 * populated, so eleven counterparties look like eleven counterparties.
 */
export function ringCounts(n: number): number[] {
  if (n <= 0) return [];
  let rings = 1;
  let capacity = ringCapacity(1);
  while (capacity < n) {
    rings += 1;
    capacity += ringCapacity(rings);
  }
  if (rings === 1) return [n];

  const caps = Array.from({ length: rings }, (_, i) => ringCapacity(i + 1));
  const counts = caps.map((cap) => Math.floor((n * cap) / capacity));
  let remainder = n - counts.reduce((sum, c) => sum + c, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % rings) {
    counts[i] += 1;
    remainder -= 1;
  }
  return counts;
}

/**
 * Positions for `n` counterparties around a centre at (0, 0).
 *
 * Each ring divides its circle EVENLY from 12 o'clock, and every second ring
 * is rotated by half of its OWN step — so the rings do not all begin with a
 * node at the top, which reads as a single spoke of bubbles rather than as
 * orbits. (It cannot guarantee no shared spoke: rings hold different
 * populations, so some angles coincide. Harmless — the radii differ, and the
 * nodes never overlap.)
 */
export function bookLayout(n: number): BookPlacement[] {
  const out: BookPlacement[] = [];
  ringCounts(n).forEach((countInRing, index) => {
    const ring = index + 1;
    const radius = ringRadius(ring);
    const step = (Math.PI * 2) / countInRing;
    const offset = ring % 2 === 0 ? step / 2 : 0;
    for (let i = 0; i < countInRing; i += 1) {
      const angle = -Math.PI / 2 + offset + i * step;
      out.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        ring,
      });
    }
  });
  return out;
}

/** Smallest and largest counterparty bubble. The centre sphere is sized by the
 *  option builder, which knows it is the hub. */
export const BOOK_NODE_MIN = 16;
export const BOOK_NODE_MAX = 46;

/**
 * Bubble diameter for a counterparty holding `value` of the caller's parts.
 *
 * AREA is proportional to the count (diameter to its square root), which is
 * how a reader actually compares circles — scaling the diameter linearly makes
 * a supplier with four times the parts look sixteen times bigger. A single
 * counterparty, or a set that all hold the same count, renders at the maximum
 * rather than dividing by zero.
 */
export function bookNodeSize(value: number, max: number): number {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  const ceiling = Number.isFinite(max) ? Math.max(0, max) : 0;
  if (ceiling <= 0) return BOOK_NODE_MIN;
  const ratio = Math.sqrt(Math.min(1, v / ceiling));
  return BOOK_NODE_MIN + (BOOK_NODE_MAX - BOOK_NODE_MIN) * ratio;
}
