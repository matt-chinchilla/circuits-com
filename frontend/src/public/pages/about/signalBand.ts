// signalBand — the pure half of the About page's logic-analyzer band.
//
// Five slow signal lanes, drawn left to right as the band is "acquired", then
// rolling. Everything here is DOM-free: the constants, the 8N1 serial framing,
// the lane levels and `paint`, which draws ONE frame into any 2D context (a
// real canvas in SignalBand.tsx, a recording fake in the tests). Transcribed
// from the owner-approved prototype (`refined(panel)`, about-ambient-options
// v5); the only change is placement — the band is its own element, so a lane
// row spans the element's full height instead of a rect inside a taller panel.
// Spec: docs/superpowers/specs/2026-09-25-about-page-design.md, "Revision 2".

/** The Why section's ground, `#0f1721`, as an rgb triple (pinned to `--why-bg` by test). */
export const NAVY = '15,23,33';
/** Pixels per bit. */
export const BIT = 34;
/** Roll speed once acquired, px/s. */
export const SPEED = 14;
/** Every lane repeats after this many bits. */
export const CYCLE = 200;
/** Seconds the left-to-right acquisition takes. */
export const ACQUIRE_S = 1.6;
/** 30 fps cap: a tick closer than this to the last drawn frame draws nothing. */
export const FRAME_MS = 33;
/** A step longer than this (a stalled tab, a resumed loop) advances only this far. */
export const MAX_STEP_S = 0.1;
/** Backing-store density ceiling. */
export const MAX_DPR = 2;

/** The site accent. */
export const GREEN = '68,189,19';
export const CYAN = '95,196,214';

const MONO = 'ui-monospace, SF Mono, Menlo, Consolas, monospace';
const LABEL_FONT = `600 10.5px ${MONO}`;
const LABEL_FILL = 'rgba(255,255,255,.4)';
const LABEL_X = 18;
const SWEEP_FILL = 'rgba(127,208,220,.55)';
const SWEEP_W = 1.5;
/** Where the waves start, right of the labels. */
export const X0 = 66;
/** The last 22% of the width fades to the ground. */
export const FADE_FROM = 0.78;
const AMP = 0.3;

/** 8N1 serial: per char, a start bit 0, eight data bits LSB first, a stop bit 1. */
export function uart(text: string): number[] {
  const bits: number[] = [];
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    bits.push(0);
    for (let i = 0; i < 8; i++) bits.push((c >> i) & 1);
    bits.push(1);
  }
  return bits;
}

/** Bit index into one cycle, for any integer k (negative included). */
export const mod = (k: number): number => ((k % CYCLE) + CYCLE) % CYCLE;

/** A line that idles high and carries `text` as one 8N1 frame from bit `start` of each cycle. */
function frame(start: number, text: string): (k: number) => number {
  const bits = uart(text);
  return (k) => {
    const i = mod(k) - start;
    return i >= 0 && i < bits.length ? bits[i] : 1;
  };
}

/** The prototype's integer mix (a 32-bit finaliser); the lane takes its low bit. */
export function hash(n: number): number {
  let h = Math.imul(n ^ (n >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export interface Lane {
  readonly name: string;
  /** rgb triple, e.g. '68,189,19'. */
  readonly rgb: string;
  /** Active-low: a bar is drawn over the name. */
  readonly bar?: boolean;
  /** The line's level (0 or 1) during bit k. */
  readonly level: (k: number) => number;
}

/** Display order, top to bottom. */
export const LANES: readonly Lane[] = [
  { name: 'CLK', rgb: GREEN, level: (k) => k & 1 },
  { name: 'CS', rgb: GREEN, bar: true, level: () => 0 },
  { name: 'TX', rgb: CYAN, level: frame(6, 'UPDATE') },
  { name: 'RX', rgb: CYAN, level: frame(90, 'FEEDBACK') },
  // Through mod, so SDA repeats with the other lanes (identical to the
  // prototype's raw k for the first CYCLE bits, which is all it ever showed).
  { name: 'SDA', rgb: CYAN, level: (k) => hash(mod(k) * 31 + 977) & 1 },
];

/** How far the band has got: acquisition 0 → 1, then px rolled. */
export interface BandState {
  acq: number;
  scroll: number;
}

/**
 * One step of the band's clock. Acquisition runs 0 → 1 over ACQUIRE_S; after
 * that the trace rolls at SPEED. `dt` is clamped to MAX_STEP_S, so a resumed
 * loop continues where it paused rather than jumping ahead by the pause.
 */
export function advance(state: BandState, dt: number): BandState {
  const step = Math.min(Math.max(dt, 0), MAX_STEP_S);
  if (state.acq < 1) return { acq: Math.min(1, state.acq + step / ACQUIRE_S), scroll: state.scroll };
  return { acq: 1, scroll: state.scroll + step * SPEED };
}

/** Everything `paint` touches on a 2D context. */
export type PaintContext = Pick<
  CanvasRenderingContext2D,
  | 'setTransform'
  | 'clearRect'
  | 'fillText'
  | 'fillRect'
  | 'measureText'
  | 'save'
  | 'restore'
  | 'beginPath'
  | 'rect'
  | 'clip'
  | 'moveTo'
  | 'lineTo'
  | 'stroke'
  | 'createLinearGradient'
  | 'font'
  | 'fillStyle'
  | 'strokeStyle'
  | 'lineWidth'
  | 'lineJoin'
>;

export interface BandFrame extends BandState {
  /** CSS px. */
  width: number;
  height: number;
  dpr: number;
}

/**
 * Draw one frame: the lane labels, the waves clipped to the acquired width,
 * the fade into the ground, and — while acquiring — the sweep line at the
 * reveal edge. The canvas stays transparent (the section's navy shows through).
 */
export function paint(ctx: PaintContext, { width: W, height: H, dpr, scroll, acq }: BandFrame): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const gap = H / LANES.length;
  const reveal = X0 + (W - X0) * acq;

  ctx.font = LABEL_FONT;
  ctx.fillStyle = LABEL_FILL;
  LANES.forEach((lane, i) => {
    const yc = i * gap + gap / 2;
    ctx.fillText(lane.name, LABEL_X, yc + 4);
    if (lane.bar) ctx.fillRect(LABEL_X, yc - 8, ctx.measureText(lane.name).width, 1);
  });

  ctx.save();
  ctx.beginPath();
  ctx.rect(X0 - 1, -2, Math.max(0, reveal - X0 + 1), H + 4);
  ctx.clip();
  const firstBit = Math.floor(scroll / BIT);
  const off = scroll - firstBit * BIT;
  const amp = gap * AMP;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'miter';
  LANES.forEach((lane, i) => {
    const yc = i * gap + gap / 2;
    ctx.strokeStyle = `rgba(${lane.rgb},.34)`;
    ctx.beginPath();
    let x = X0 - off;
    let k = firstBit;
    let prev: number | null = null;
    while (x < W + BIT) {
      const y = lane.level(k) ? yc - amp : yc + amp;
      if (prev === null) ctx.moveTo(x, y);
      else {
        ctx.lineTo(x, prev);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(x + BIT, y);
      prev = y;
      x += BIT;
      k += 1;
    }
    ctx.stroke();
  });
  ctx.restore();

  // The trace fades out before the right edge rather than hitting it.
  const fadeX = W * FADE_FROM;
  const fade = ctx.createLinearGradient(fadeX, 0, W, 0);
  fade.addColorStop(0, `rgba(${NAVY},0)`);
  fade.addColorStop(1, `rgba(${NAVY},1)`);
  ctx.fillStyle = fade;
  ctx.fillRect(fadeX, -2, W - fadeX, H + 4);

  if (acq > 0 && acq < 1) {
    ctx.fillStyle = SWEEP_FILL;
    ctx.fillRect(Math.min(reveal, fadeX), -2, SWEEP_W, H + 4);
  }
}
