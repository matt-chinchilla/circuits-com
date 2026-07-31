// Dominant-color extraction from a logo image (for the Platinum drag-a-logo
// pitch mode, and the admin sponsor form's swatch picker). Downscales to
// 28px, buckets opaque pixels by hue, picks the most populated SATURATED
// bucket as primary; secondary is a brightened accent of the runner-up hue
// (or of the primary when the logo is one-colored). Ported 1:1 out of
// csFx.tsx's prior in-file logo-color helper (2026-07-10) — EVERY numeric
// constant, skip rule, and branch is preserved; the only change is
// color-mix() strings becoming concrete hex via mixHex, plus ranked
// bucket-average `swatches`.

import { mixHex, rgbToHex } from './color';

export interface RankedSwatch {
  hex: string;
  pct: number;
}

export interface BrandPalette {
  primary: string;
  secondary: string;
  swatches: RankedSwatch[];
}

export interface PaletteOptions {
  /** Picker mode: black/white ink pools become ranked swatches (and the
   *  primary when no saturated hue exists). The DEFAULT (false) preserves the
   *  csFx board-tint behavior 1:1, where tinting a board black/white is
   *  useless and both are gated out. */
  includeAchromatic?: boolean;
  /** Downsample edge for extractBrandPalette. The csFx default is 28; the
   *  picker uses a finer 64 so a thin accent mark survives the resample. */
  sample?: number;
}

// Constants preserved 1:1 from the original csFx.tsx logo-color helper (2026-07-10).
const SAMPLE = 28;
const ALPHA_MIN = 140;
const LIGHT_MAX = 0.94;
const LIGHT_MIN = 0.06;
const SAT_MIN = 0.28;
const BUCKET_DEG = 24;
const FALLBACK_PRIMARY = '#3a6ea5';
const MAX_SWATCHES = 6;

interface Bucket {
  n: number;
  r: number;
  g: number;
  b: number;
}

/** HSL hue in degrees — mirrors the original csFx.tsx hue math exactly, including d<=0 → 0. */
function rgbHue(r: number, g: number, b: number, max: number, min: number): number {
  const d = max - min;
  if (d <= 0) return 0;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360);
}

export function paletteFromPixels(
  data: Uint8ClampedArray,
  pixelCount: number,
  opts: PaletteOptions = {},
): BrandPalette {
  const { includeAchromatic = false } = opts;
  const buckets = new Map<number, Bucket>();
  let fbN = 0;
  let fbR = 0;
  let fbG = 0;
  let fbB = 0;
  // Picker-mode ink pools: the OPAQUE pixels the base gates throw away —
  // near-black (l < LIGHT_MIN) and near-white (l > LIGHT_MAX). For a brand
  // PICKER these are legitimate answers (most wordmarks are black or white).
  const black: Bucket = { n: 0, r: 0, g: 0, b: 0 };
  const white: Bucket = { n: 0, r: 0, g: 0, b: 0 };
  for (let i = 0; i < pixelCount; i++) {
    const o = i * 4;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const a = data[o + 3];
    if (a < ALPHA_MIN) continue;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 510;
    if (l > LIGHT_MAX || l < LIGHT_MIN) {
      if (includeAchromatic) {
        const pool = l < LIGHT_MIN ? black : white;
        pool.n += 1;
        pool.r += r;
        pool.g += g;
        pool.b += b;
      }
      continue;
    }
    fbN += 1;
    fbR += r;
    fbG += g;
    fbB += b;
    if (max === 0 || (max - min) / max < SAT_MIN) continue;
    const key = Math.floor(rgbHue(r, g, b, max, min) / BUCKET_DEG);
    const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bucket.n += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    buckets.set(key, bucket);
  }
  const sorted = [...buckets.values()].sort((x, y) => y.n - x.n);
  const avg = (k: Bucket) => rgbToHex(k.r / k.n, k.g / k.n, k.b / k.n);
  // Picker mode: an achromatic logo answers with its DOMINANT INK, never the
  // base fallback (an average of anti-aliasing edge grays — the #939393 bug).
  // Black is preferred as "ink" even when outnumbered — a big white pool is
  // usually backing, not brand — unless black is negligible (white-ink logo).
  const inkPrimary =
    includeAchromatic && !sorted[0] && (black.n || white.n)
      ? avg(black.n > 0 && black.n >= white.n * 0.15 ? black : white)
      : null;
  const primary =
    (sorted[0] ? avg(sorted[0]) : null) ??
    inkPrimary ??
    (fbN ? rgbToHex(fbR / fbN, fbG / fbN, fbB / fbN) : FALLBACK_PRIMARY);
  const secondary =
    sorted[1] && sorted[1].n > sorted[0].n * 0.2
      ? mixHex(avg(sorted[1]), '#ffffff', 0.72)
      : mixHex(primary, '#ffffff', 0.52);
  // Picker mode ranks the ink pools alongside the hue buckets (≥1% floor via
  // the same rounding); pct denominator grows to include them so shares sum.
  const denom = includeAchromatic ? fbN + black.n + white.n : fbN;
  const ranked: Array<{ bucket: Bucket }> = sorted.map((bucket) => ({ bucket }));
  if (includeAchromatic) {
    for (const pool of [black, white]) {
      if (pool.n > 0) ranked.push({ bucket: pool });
    }
    ranked.sort((x, y) => y.bucket.n - x.bucket.n);
  }
  const swatches: RankedSwatch[] = ranked.slice(0, MAX_SWATCHES).map(({ bucket }) => ({
    hex: avg(bucket),
    pct: Math.max(1, Math.round((bucket.n / denom) * 100)),
  }));
  return { primary, secondary, swatches: swatches.length ? swatches : [{ hex: primary, pct: 100 }] };
}

export function extractBrandPalette(
  source: HTMLImageElement | HTMLCanvasElement,
  opts: PaletteOptions = {},
): BrandPalette | null {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!w || !h) return null;
  const sample = opts.sample ?? SAMPLE;
  const canvas = document.createElement('canvas');
  canvas.width = sample;
  canvas.height = sample;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, sample, sample);
    const { data } = ctx.getImageData(0, 0, sample, sample);
    return paletteFromPixels(data, sample * sample, opts);
  } catch (err) {
    console.error('extractBrandPalette failed (tainted canvas?)', err);
    return null;
  }
}

export const DEFAULT_PALETTE: BrandPalette = {
  primary: FALLBACK_PRIMARY,
  secondary: mixHex(FALLBACK_PRIMARY, '#ffffff', 0.52),
  swatches: [{ hex: FALLBACK_PRIMARY, pct: 100 }],
};
