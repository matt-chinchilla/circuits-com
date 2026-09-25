/**
 * signalBand — the pure half of the About page's logic-analyzer band.
 *
 * Pins the signal itself (8N1 framing, what each lane carries and where), the
 * clock rule (acquire over ACQUIRE_S, then roll at SPEED, steps clamped), the
 * NAVY constant against the section's `--why-bg`, and what one `paint` draws,
 * through a recording fake 2D context. The SCSS is read from disk: vitest's
 * `css` is off, so a CSS-module import proves nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACQUIRE_S,
  BIT,
  CYAN,
  CYCLE,
  FADE_FROM,
  GREEN,
  LANES,
  MAX_STEP_S,
  NAVY,
  SPEED,
  X0,
  advance,
  mod,
  paint,
  uart,
  type PaintContext,
} from './signalBand';

const lane = (name: string) => {
  const found = LANES.find((l) => l.name === name);
  if (!found) throw new Error(`no lane ${name}`);
  return found;
};
const levels = (name: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => lane(name).level(from + i));

/** Records every call and property write, in order. */
function recorder() {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const gradient = { addColorStop: (...args: unknown[]) => calls.push({ op: 'addColorStop', args }) };
  const ctx = new Proxy(
    {},
    {
      get: (_t, key) => {
        const op = String(key);
        if (op === 'measureText') return (s: string) => ({ width: s.length * 6 });
        if (op === 'createLinearGradient')
          return (...args: unknown[]) => {
            calls.push({ op, args });
            return gradient;
          };
        return (...args: unknown[]) => {
          calls.push({ op, args });
        };
      },
      set: (_t, key, value) => {
        calls.push({ op: `${String(key)}=`, args: [value] });
        return true;
      },
    },
  ) as unknown as PaintContext;
  const of = (op: string) => calls.filter((c) => c.op === op).map((c) => c.args);
  return { ctx, calls, of };
}

describe('uart', () => {
  it("frames 'A' as start 0, 0x41 LSB first, stop 1", () => {
    expect(uart('A')).toEqual([0, 1, 0, 0, 0, 0, 0, 1, 0, 1]);
  });
  it('is ten bits per character, each framed by a 0 and a 1', () => {
    const bits = uart('UPDATE');
    expect(bits).toHaveLength(60);
    for (let c = 0; c < 6; c++) {
      expect(bits[c * 10]).toBe(0);
      expect(bits[c * 10 + 9]).toBe(1);
    }
  });
});

describe('LANES', () => {
  it('are CLK, CS, TX, RX, SDA in display order, green then cyan', () => {
    expect(LANES.map((l) => l.name)).toEqual(['CLK', 'CS', 'TX', 'RX', 'SDA']);
    expect(LANES.map((l) => l.rgb)).toEqual([GREEN, GREEN, CYAN, CYAN, CYAN]);
    expect(GREEN).toBe('68,189,19');
    expect(CYAN).toBe('95,196,214');
    expect(LANES.filter((l) => l.bar).map((l) => l.name)).toEqual(['CS']);
  });

  it('CLK alternates every bit, starting low', () => {
    expect(levels('CLK', 0, 6)).toEqual([0, 1, 0, 1, 0, 1]);
  });

  it('CS is held low (asserted) throughout', () => {
    expect(new Set(levels('CS', -CYCLE, 2 * CYCLE))).toEqual(new Set([0]));
  });

  it("TX carries 'UPDATE' on bits 6..65 and idles high everywhere else", () => {
    expect(levels('TX', 6, 66)).toEqual(uart('UPDATE'));
    expect(new Set([...levels('TX', 0, 6), ...levels('TX', 66, CYCLE)])).toEqual(new Set([1]));
  });

  it("RX carries 'FEEDBACK' on bits 90..169 and idles high everywhere else", () => {
    expect(levels('RX', 90, 170)).toEqual(uart('FEEDBACK'));
    expect(new Set([...levels('RX', 0, 90), ...levels('RX', 170, CYCLE)])).toEqual(new Set([1]));
  });

  it('SDA is data: both levels, and fixed for a given bit', () => {
    const sda = levels('SDA', 0, CYCLE);
    expect(new Set(sda)).toEqual(new Set([0, 1]));
    expect(levels('SDA', 0, CYCLE)).toEqual(sda);
  });

  it('every lane is binary and periodic in CYCLE, negative bits included', () => {
    for (const l of LANES) {
      for (let k = -CYCLE; k < 2 * CYCLE; k++) {
        expect([0, 1]).toContain(l.level(k));
        expect(l.level(k + CYCLE)).toBe(l.level(k));
      }
    }
    expect(mod(-1)).toBe(CYCLE - 1);
    expect(mod(CYCLE + 3)).toBe(3);
  });
});

describe('advance', () => {
  it('acquires 0 → 1 over ACQUIRE_S without rolling', () => {
    let s = { acq: 0, scroll: 0 };
    const steps = Math.round(ACQUIRE_S / 0.05);
    for (let i = 0; i < steps - 1; i++) s = advance(s, 0.05);
    expect(s.acq).toBeGreaterThan(0.9);
    expect(s.acq).toBeLessThan(1);
    expect(s.scroll).toBe(0);
    s = advance(s, 0.05);
    expect(s.acq).toBeCloseTo(1, 9);
  });

  it('then rolls at SPEED px/s', () => {
    const s = advance({ acq: 1, scroll: 10 }, 0.05);
    expect(s).toEqual({ acq: 1, scroll: 10 + 0.05 * SPEED });
  });

  it('clamps a long step (a stalled or resumed loop) to MAX_STEP_S, and ignores a negative one', () => {
    expect(advance({ acq: 1, scroll: 0 }, 5).scroll).toBeCloseTo(MAX_STEP_S * SPEED, 9);
    expect(advance({ acq: 0, scroll: 0 }, 5).acq).toBeCloseTo(MAX_STEP_S / ACQUIRE_S, 9);
    expect(advance({ acq: 1, scroll: 7 }, -1)).toEqual({ acq: 1, scroll: 7 });
  });
});

describe('paint', () => {
  const frame = { width: 800, height: 180, dpr: 2, scroll: 0, acq: 1 };

  it('clears a transparent canvas at device scale (never fills a ground)', () => {
    const { ctx, calls, of } = recorder();
    paint(ctx, frame);
    expect(calls[0]).toEqual({ op: 'setTransform', args: [2, 0, 0, 2, 0, 0] });
    expect(of('clearRect')).toEqual([[0, 0, 800, 180]]);
  });

  it('labels the five lanes at x = 18, one per fifth of the height, with a bar over CS', () => {
    const { ctx, of } = recorder();
    paint(ctx, frame);
    const gap = 180 / 5;
    expect(of('fillText')).toEqual(LANES.map((l, i) => [l.name, 18, i * gap + gap / 2 + 4]));
    expect(of('font=')).toEqual([['600 10.5px ui-monospace, SF Mono, Menlo, Consolas, monospace']]);
    expect(of('fillRect')).toContainEqual([18, gap + gap / 2 - 8, 'CS'.length * 6, 1]);
  });

  it('strokes each lane in its colour at .34 alpha, miter-joined, width 1.2', () => {
    const { ctx, of } = recorder();
    paint(ctx, frame);
    expect(of('strokeStyle=')).toEqual(LANES.map((l) => [`rgba(${l.rgb},.34)`]));
    expect(of('stroke')).toHaveLength(5);
    expect(of('lineWidth=')).toEqual([[1.2]]);
    expect(of('lineJoin=')).toEqual([['miter']]);
  });

  it('draws CLK as a square wave of BIT-wide cells from x0 = 66, amplitude 30% of a lane', () => {
    const { ctx, calls } = recorder();
    paint(ctx, frame);
    const gap = 180 / 5;
    const yc = gap / 2;
    const amp = gap * 0.3;
    const firstMove = calls.find((c) => c.op === 'moveTo');
    expect(firstMove?.args).toEqual([X0, yc + amp]); // CLK bit 0 is low (y grows downward)
    const afterMove = calls.slice(calls.indexOf(firstMove!) + 1, calls.indexOf(firstMove!) + 4);
    expect(afterMove.map((c) => c.args)).toEqual([
      [X0 + BIT, yc + amp],
      [X0 + BIT, yc + amp],
      [X0 + BIT, yc - amp],
    ]);
  });

  it('clips the waves to the acquired width', () => {
    const half = recorder();
    paint(half.ctx, { ...frame, acq: 0.5 });
    const reveal = X0 + (800 - X0) * 0.5;
    expect(half.of('rect')).toEqual([[X0 - 1, -2, reveal - X0 + 1, 184]]);
    const none = recorder();
    paint(none.ctx, { ...frame, acq: 0 });
    expect(none.of('rect')).toEqual([[X0 - 1, -2, 1, 184]]);
  });

  it('shifts the waves left by the scroll, and starts at the scrolled bit', () => {
    const { ctx, calls } = recorder();
    paint(ctx, { ...frame, scroll: BIT * 3 + 10 });
    const firstMove = calls.find((c) => c.op === 'moveTo');
    const gap = 180 / 5;
    // CLK bit 3 is high
    expect(firstMove?.args).toEqual([X0 - 10, gap / 2 - gap * 0.3]);
  });

  it('fades the last 22% of the width into the navy ground', () => {
    const { ctx, of } = recorder();
    paint(ctx, frame);
    expect(of('createLinearGradient')).toEqual([[800 * FADE_FROM, 0, 800, 0]]);
    expect(of('addColorStop')).toEqual([
      [0, `rgba(${NAVY},0)`],
      [1, `rgba(${NAVY},1)`],
    ]);
    const fadeRect = of('fillRect').find((a) => a[0] === 800 * FADE_FROM);
    expect(fadeRect?.[2]).toBeCloseTo(800 * 0.22, 9);
  });

  it('draws the sweep line at the reveal edge only while acquiring', () => {
    const sweep = (acq: number) => {
      const r = recorder();
      paint(r.ctx, { ...frame, acq });
      return r.of('fillRect').filter((a) => a[2] === 1.5);
    };
    expect(sweep(0)).toEqual([]);
    expect(sweep(1)).toEqual([]);
    expect(sweep(0.25)).toEqual([[X0 + (800 - X0) * 0.25, -2, 1.5, 184]]);
    // never inside the fade
    expect(sweep(0.95)).toEqual([[800 * FADE_FROM, -2, 1.5, 184]]);
  });
});

describe('NAVY', () => {
  it("is the Why section's --why-bg ground", () => {
    const scss = readFileSync(join(__dirname, 'AboutPage.module.scss'), 'utf8');
    const hex = /--why-bg:\s*#([0-9a-f]{6})\s*;/i.exec(scss)?.[1];
    expect(hex, '--why-bg is declared in AboutPage.module.scss').toBeDefined();
    const rgb = [0, 2, 4].map((i) => parseInt(hex!.slice(i, i + 2), 16)).join(',');
    expect(rgb).toBe(NAVY);
    expect(hex!.toLowerCase()).toBe('0f1721');
  });
});
