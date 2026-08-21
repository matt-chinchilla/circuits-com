import { describe, expect, it } from 'vitest';
import {
  flagEmoji,
  monotoneAreaPath,
  monotonePath,
  monotoneSegments,
  refHost,
  tooltipAnchor,
} from './chartKit';
import type { Pt } from './chartKit';

function bezierY(
  y0: number,
  c1y: number,
  c2y: number,
  y1: number,
  t: number,
): number {
  const u = 1 - t;
  return u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1;
}

describe('monotoneSegments', () => {
  it('never overshoots segment endpoints (the honesty constraint)', () => {
    // A spike pattern that classic Catmull-Rom smoothing overshoots on.
    const pts: Pt[] = [
      { x: 0, y: 100 },
      { x: 10, y: 100 },
      { x: 20, y: 5 },
      { x: 30, y: 100 },
      { x: 40, y: 100 },
    ];
    const segs = monotoneSegments(pts);
    segs.forEach((s, i) => {
      const y0 = pts[i].y;
      const y1 = pts[i + 1].y;
      const lo = Math.min(y0, y1) - 1e-9;
      const hi = Math.max(y0, y1) + 1e-9;
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const y = bezierY(y0, s.c1y, s.c2y, y1, Math.min(t, 1));
        expect(y).toBeGreaterThanOrEqual(lo);
        expect(y).toBeLessThanOrEqual(hi);
      }
    });
  });

  it('interpolates through every data point', () => {
    const pts: Pt[] = [
      { x: 0, y: 3 },
      { x: 5, y: 9 },
      { x: 12, y: 4 },
    ];
    const segs = monotoneSegments(pts);
    expect(segs).toHaveLength(2);
    expect(segs[0].x).toBe(5);
    expect(segs[0].y).toBe(9);
    expect(segs[1].x).toBe(12);
    expect(segs[1].y).toBe(4);
  });

  it('flat data stays flat', () => {
    const pts: Pt[] = [
      { x: 0, y: 50 },
      { x: 10, y: 50 },
      { x: 20, y: 50 },
    ];
    for (const s of monotoneSegments(pts)) {
      expect(s.c1y).toBeCloseTo(50);
      expect(s.c2y).toBeCloseTo(50);
    }
  });
});

describe('monotonePath / monotoneAreaPath', () => {
  it('builds a cubic path starting at the first point', () => {
    const p = monotonePath([
      { x: 0, y: 1 },
      { x: 10, y: 2 },
    ]);
    expect(p.startsWith('M 0,1 C ')).toBe(true);
  });

  it('area closes to the baseline', () => {
    const a = monotoneAreaPath(
      [
        { x: 0, y: 1 },
        { x: 10, y: 2 },
      ],
      100,
    );
    expect(a.endsWith('L 10,100 L 0,100 Z')).toBe(true);
  });

  it('degenerate inputs are safe', () => {
    expect(monotonePath([])).toBe('');
    expect(monotonePath([{ x: 3, y: 4 }])).toBe('M 3,4');
    expect(monotoneAreaPath([{ x: 3, y: 4 }], 10)).toBe('');
  });
});

describe('tooltipAnchor', () => {
  it('anchors above the dot by default', () => {
    const a = tooltipAnchor(400, 150, 800, 240);
    expect(a.transform).toContain('-100%');
    expect(a.left).toBe('50%');
  });

  it('flips below near the top edge', () => {
    const a = tooltipAnchor(400, 20, 800, 240);
    expect(a.transform).not.toContain('-100%');
  });

  it('clamps horizontally at the edges', () => {
    expect(tooltipAnchor(0, 150, 800, 240).left).toBe(`${(70 / 800) * 100}%`);
    expect(tooltipAnchor(800, 150, 800, 240).left).toBe(`${(730 / 800) * 100}%`);
  });
});

describe('refHost', () => {
  it('strips protocol, path and www', () => {
    expect(refHost('https://www.google.com/')).toBe('google.com');
    expect(refHost('https://checkout.stripe.com/c/pay/x')).toBe('checkout.stripe.com');
  });

  it('passes non-URLs through', () => {
    expect(refHost('(direct)')).toBe('(direct)');
  });
});

describe('flagEmoji', () => {
  it('maps ISO codes to regional indicators', () => {
    expect(flagEmoji('US')).toBe('\u{1F1FA}\u{1F1F8}');
    expect(flagEmoji('de')).toBe('\u{1F1E9}\u{1F1EA}');
  });

  it('rejects junk', () => {
    expect(flagEmoji('')).toBe('');
    expect(flagEmoji('USA')).toBe('');
    expect(flagEmoji('1x')).toBe('');
  });
});
