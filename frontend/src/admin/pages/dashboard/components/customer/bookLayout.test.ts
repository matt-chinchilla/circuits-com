import { describe, expect, it } from 'vitest';
import {
  BOOK_NODE_MAX,
  BOOK_NODE_MIN,
  bookLayout,
  bookNodeSize,
  ringCounts,
} from './bookLayout';

describe('ringCounts', () => {
  it('is empty for no counterparties', () => {
    expect(ringCounts(0)).toEqual([]);
    expect(ringCounts(-3)).toEqual([]);
  });

  it('keeps a small book on one ring', () => {
    expect(ringCounts(1)).toEqual([1]);
    expect(ringCounts(10)).toEqual([10]);
  });

  it('never strands a lone node on an outer ring', () => {
    // Filling ring one to its capacity first would place 10 and then 1, which
    // reads as a mistake rather than as eleven counterparties.
    const counts = ringCounts(11);
    expect(counts).toHaveLength(2);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(11);
    expect(Math.min(...counts)).toBeGreaterThan(1);
  });

  it('always places every node', () => {
    for (let n = 1; n <= 48; n += 1) {
      expect(ringCounts(n).reduce((a, b) => a + b, 0)).toBe(n);
    }
  });

  it('opens a third ring only when two cannot hold the book', () => {
    expect(ringCounts(26)).toHaveLength(2);
    expect(ringCounts(27)).toHaveLength(3);
  });
});

describe('bookLayout', () => {
  it('starts the first ring at 12 o’clock', () => {
    const [only] = bookLayout(1);
    expect(only.x).toBeCloseTo(0, 6);
    expect(only.y).toBeCloseTo(-130, 6);
    expect(only.ring).toBe(1);
  });

  it('divides each ring evenly', () => {
    const ring = bookLayout(4);
    const radii = ring.map((p) => Math.hypot(p.x, p.y));
    for (const r of radii) expect(r).toBeCloseTo(130, 6);
    // Four nodes, a quarter-turn apart: one at each compass point.
    expect(ring[1].x).toBeCloseTo(130, 6);
    expect(ring[1].y).toBeCloseTo(0, 6);
  });

  it('rotates every second ring so the rings do not share one spoke at the top', () => {
    const nodes = bookLayout(20);
    const outerFirst = nodes.find((p) => p.ring === 2);
    expect(outerFirst).toBeDefined();
    // Ring one opens at 12 o'clock; ring two must not.
    expect(nodes[0].x).toBeCloseTo(0, 6);
    expect(Math.abs((outerFirst as { x: number }).x)).toBeGreaterThan(1);
  });

  it('puts every node in a distinct place', () => {
    const nodes = bookLayout(40);
    expect(nodes).toHaveLength(40);
    const keys = new Set(nodes.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`));
    expect(keys.size).toBe(40);
  });

  it('grows the radius ring by ring', () => {
    const nodes = bookLayout(30);
    expect(nodes.some((p) => p.ring === 3)).toBe(true);
    const radiusOf = (ring: number) => {
      const node = nodes.find((p) => p.ring === ring);
      return node ? Math.hypot(node.x, node.y) : 0;
    };
    expect(radiusOf(2)).toBeGreaterThan(radiusOf(1));
    expect(radiusOf(3)).toBeGreaterThan(radiusOf(2));
  });
});

describe('bookNodeSize', () => {
  it('scales by AREA, not by diameter', () => {
    // Four times the parts is twice the diameter of the span, never four.
    const quarter = bookNodeSize(25, 100);
    const full = bookNodeSize(100, 100);
    expect(full).toBeCloseTo(BOOK_NODE_MAX, 6);
    expect(quarter - BOOK_NODE_MIN).toBeCloseTo((BOOK_NODE_MAX - BOOK_NODE_MIN) / 2, 6);
  });

  it('never divides by zero', () => {
    expect(bookNodeSize(0, 0)).toBe(BOOK_NODE_MIN);
    expect(bookNodeSize(5, 0)).toBe(BOOK_NODE_MIN);
  });

  it('clamps a value above the ceiling', () => {
    expect(bookNodeSize(500, 100)).toBeCloseTo(BOOK_NODE_MAX, 6);
  });
});
