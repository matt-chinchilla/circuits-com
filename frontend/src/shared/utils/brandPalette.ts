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

export interface BrandPalette {
  primary: string;
  secondary: string;
  swatches: string[];
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

export function paletteFromPixels(data: Uint8ClampedArray, pixelCount: number): BrandPalette {
  const buckets = new Map<number, Bucket>();
  let fbN = 0;
  let fbR = 0;
  let fbG = 0;
  let fbB = 0;
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
    if (l > LIGHT_MAX || l < LIGHT_MIN) continue;
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
  const primary = sorted[0] ? avg(sorted[0]) : fbN ? rgbToHex(fbR / fbN, fbG / fbN, fbB / fbN) : FALLBACK_PRIMARY;
  const secondary =
    sorted[1] && sorted[1].n > sorted[0].n * 0.2
      ? mixHex(avg(sorted[1]), '#ffffff', 0.72)
      : mixHex(primary, '#ffffff', 0.52);
  const swatches = sorted.slice(0, MAX_SWATCHES).map(avg);
  return { primary, secondary, swatches: swatches.length ? swatches : [primary] };
}

export function extractBrandPalette(source: HTMLImageElement | HTMLCanvasElement): BrandPalette | null {
  const w = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const h = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(source, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    return paletteFromPixels(data, SAMPLE * SAMPLE);
  } catch (err) {
    console.error('extractBrandPalette failed (tainted canvas?)', err);
    return null;
  }
}

export const DEFAULT_PALETTE: BrandPalette = {
  primary: FALLBACK_PRIMARY,
  secondary: mixHex(FALLBACK_PRIMARY, '#ffffff', 0.52),
  swatches: [FALLBACK_PRIMARY],
};
