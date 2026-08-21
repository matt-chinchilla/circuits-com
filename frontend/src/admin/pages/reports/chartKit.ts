// Shared math/behavior for the Reports page's hand-rolled SVG charts.
//
// monotone* — Steffen monotone-cubic interpolation: smoothed lines that can
// NEVER overshoot the data (no invented local maxima on sparse daily series;
// the honesty constraint that rules out naive Catmull-Rom smoothing).
//
// tooltipAnchor — tooltips anchor ABOVE the hovered dot (owner requirement:
// the old placement covered the data area), flipping below only when the dot
// is too close to the chart's top edge to fit a tip above it.

export interface Pt {
  x: number;
  y: number;
}

export interface BezierSeg {
  c1x: number;
  c1y: number;
  c2x: number;
  c2y: number;
  x: number;
  y: number;
}

/** Steffen (1990) monotone tangents → cubic segments. Interpolant stays
 *  within each segment's [min(y), max(y)] by construction. */
export function monotoneSegments(pts: Pt[]): BezierSeg[] {
  const n = pts.length;
  if (n < 2) return [];
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(pts[i + 1].x - pts[i].x);
    d.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x));
  }
  const t: number[] = new Array(n);
  t[0] = d[0];
  t[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      t[i] = 0;
      continue;
    }
    const p = (d[i - 1] * h[i] + d[i] * h[i - 1]) / (h[i - 1] + h[i]);
    t[i] =
      (Math.sign(d[i - 1]) + Math.sign(d[i])) *
      Math.min(Math.abs(d[i - 1]), Math.abs(d[i]), 0.5 * Math.abs(p));
  }
  const segs: BezierSeg[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = h[i] / 3;
    segs.push({
      c1x: pts[i].x + dx,
      c1y: pts[i].y + t[i] * dx,
      c2x: pts[i + 1].x - dx,
      c2y: pts[i + 1].y - t[i + 1] * dx,
      x: pts[i + 1].x,
      y: pts[i + 1].y,
    });
  }
  return segs;
}

/** SVG path for the smoothed line through `pts`. */
export function monotonePath(pts: Pt[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M ${pts[0].x},${pts[0].y}`;
  const segs = monotoneSegments(pts);
  let path = `M ${pts[0].x},${pts[0].y}`;
  for (const s of segs) {
    path += ` C ${s.c1x},${s.c1y} ${s.c2x},${s.c2y} ${s.x},${s.y}`;
  }
  return path;
}

/** Closed area under the smoothed line, down to `baselineY`. */
export function monotoneAreaPath(pts: Pt[], baselineY: number): string {
  if (pts.length < 2) return '';
  return (
    monotonePath(pts) +
    ` L ${pts[pts.length - 1].x},${baselineY} L ${pts[0].x},${baselineY} Z`
  );
}

export interface TooltipAnchor {
  /** CSS percentage strings for the wrapper (which is position:relative). */
  left: string;
  top: string;
  /** translate keeps the tip centered on and fully ABOVE (or below) the dot
   *  without measuring its rendered height. */
  transform: string;
}

/** Anchor a tooltip to a dot at viewBox (x, y): centered horizontally,
 *  bottom edge 12px above the dot; flips below when the dot is within
 *  `flipAt` viewBox units of the top. Horizontal clamp keeps the center
 *  from pushing the tip past either edge. */
export function tooltipAnchor(
  x: number,
  y: number,
  W: number,
  H: number,
  flipAt = 84,
): TooltipAnchor {
  const clampedX = Math.min(W - 70, Math.max(70, x));
  const above = y >= flipAt;
  return {
    left: `${(clampedX / W) * 100}%`,
    top: `${(y / H) * 100}%`,
    transform: above ? 'translate(-50%, -100%) translateY(-12px)' : 'translate(-50%, 14px)',
  };
}

/** Referrer URLs render as bare hostnames (dataviz: labels carry identity,
 *  not protocol noise). Non-URLs pass through untouched. */
export function refHost(source: string): string {
  try {
    return new URL(source).hostname.replace(/^www\./, '');
  } catch {
    return source;
  }
}

/** ISO-3166 alpha-2 → regional-indicator flag emoji ("US" → 🇺🇸). */
export function flagEmoji(iso: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso)) return '';
  const up = iso.toUpperCase();
  return String.fromCodePoint(
    0x1f1e6 + (up.charCodeAt(0) - 65),
    0x1f1e6 + (up.charCodeAt(1) - 65),
  );
}
