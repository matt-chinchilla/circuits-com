/**
 * The Circuit Center mark — "The Master" (logo exploration 13a).
 *
 * WHAT IT IS. A capacitor drawn inside the counter of a C, whose right-hand
 * terminals double as the feet of an omega. C for Circuit Center, Ω for the
 * parts it indexes, and a capacitor because that is the thing itself. The
 * green is the site accent ($nav-blue #44bd13); the body is near-black
 * (#1a1f23, the same ink as --fg1).
 *
 * WHY THE WEIGHTS CHANGE WITH SIZE. Stroke widths here are OPTICALLY TUNED per
 * size band, not scaled from one master. A 22px stroke that reads correctly on
 * a 200px badge turns to mush at 16px, so the small bands thicken the strokes
 * and pull the badge inset in. These numbers come verbatim from the design's
 * own size ladder (13c) — do not "simplify" them into one geometry with a
 * transform, which is exactly what the ladder exists to avoid.
 *
 * At 16px the GROUND STEM IS DROPPED entirely. Three electrodes plus a stem
 * cannot stay legible in 16 device pixels; the design's note is "at 16px the
 * stem drops; everything else survives". Losing it deliberately beats letting
 * it silt up the counter.
 *
 * VARIANTS.
 *   badge — the dark rounded-square lockup. Standalone use: favicon, app icon,
 *           anywhere the mark needs its own ground.
 *   mark  — glyph only, no badge. For placing ON an existing dark surface: the
 *           public navbar, an avatar well, the admin rail. The glyph inherits
 *           nothing — the C and feet are always white, the capacitor always
 *           green — so the surface underneath must be dark enough to carry
 *           white at AA. On the base theme's #44bd13 bar white reads 3.1:1,
 *           which is fine for a logo (a non-text graphic needs 3:1) but would
 *           NOT be fine for body copy.
 */

/** Ω feet, top + bottom, per optical band. Mirrored about y=100. */
const FEET = {
  // 48px badge and larger — the master drawing.
  master: [
    'M 130.07 86.4 L 143.5 86.4 A 4 4 0 0 0 147.5 82.4 L 147.5 48 A 11 11 0 0 0 125.5 48 L 125.5 79.05 A 33 33 0 0 1 130.07 86.4 Z',
    'M 130.07 113.6 L 143.5 113.6 A 4 4 0 0 1 147.5 117.6 L 147.5 152 A 11 11 0 0 1 125.5 152 L 125.5 120.95 A 33 33 0 0 0 130.07 113.6 Z',
  ],
  // 32px badge, navbar and avatar.
  mid: [
    'M 129.74 86.9 L 144 86.9 A 4 4 0 0 0 148 82.9 L 148 48 A 11.5 11.5 0 0 0 125 48 L 125 79.23 A 32.5 32.5 0 0 1 129.74 86.9 Z',
    'M 129.74 113.1 L 144 113.1 A 4 4 0 0 1 148 117.1 L 148 152 A 11.5 11.5 0 0 1 125 152 L 125 120.77 A 32.5 32.5 0 0 0 129.74 113.1 Z',
  ],
  // 16px and 24px badge — widest feet, so they survive the fewest pixels.
  small: [
    'M 129 86.4 L 144.5 86.4 A 4 4 0 0 0 148.5 82.4 L 148.5 48 A 12 12 0 0 0 124.5 48 L 124.5 79.42 A 32 32 0 0 1 129 86.4 Z',
    'M 129 113.6 L 144.5 113.6 A 4 4 0 0 1 148.5 117.6 L 148.5 152 A 12 12 0 0 1 124.5 152 L 124.5 120.58 A 32 32 0 0 0 129 113.6 Z',
  ],
} as const;

/** The C's counter arc — identical at every size; only its weight changes. */
const ARC = 'M 136.5 75.4 A 44 44 0 1 0 136.5 124.6';

interface Band {
  /** Badge plate; null for the `mark` variant, which has no ground of its own. */
  plate: { inset: number; r: number } | null;
  arc: number;
  feet: readonly [string, string];
  electrode: number;
  /** null = the stem is dropped at this size (16px badge only). */
  stem: number | null;
}

const BADGE_BANDS: ReadonlyArray<readonly [number, Band]> = [
  [16, { plate: { inset: 10, r: 42 }, arc: 24, feet: FEET.small, electrode: 10, stem: null }],
  [24, { plate: { inset: 10, r: 42 }, arc: 24, feet: FEET.small, electrode: 10, stem: 12 }],
  [32, { plate: { inset: 14, r: 40 }, arc: 23, feet: FEET.mid, electrode: 10, stem: 12 }],
  [Infinity, { plate: { inset: 18, r: 38 }, arc: 22, feet: FEET.master, electrode: 9, stem: 9 }],
]

/** Glyph-only weights — navbar (22px) and avatar (37px) share one tuning. */
const MARK_BAND: Band = {
  plate: null,
  arc: 23,
  feet: FEET.mid,
  electrode: 11,
  stem: 13,
}

function bandFor(variant: 'badge' | 'mark', size: number): Band {
  if (variant === 'mark') return MARK_BAND;
  return BADGE_BANDS.find(([max]) => size <= max)![1];
}

export interface LogoProps {
  /** Rendered edge length in px. Picks the optical band; default 32. */
  size?: number;
  /** `badge` carries its own dark plate; `mark` is glyph-only for dark surfaces. */
  variant?: 'badge' | 'mark';
  /**
   * Hairline on the badge's edge. ON by default, and load-bearing: the plate is
   * #1a1f23, which against the dark navbars measures 1.14:1 (steel), 1.06:1
   * (schematic) and 1.30:1 (pcb) — i.e. the rounded square is effectively
   * INVISIBLE by fill alone on every dark surface it sits on. The rim lets the
   * shape read by its edge instead, so the mark stays one consistent object
   * everywhere rather than being a plate on light backgrounds and a bare glyph
   * on dark ones.
   *
   * Turn it off only where the badge sits on something clearly lighter than
   * the plate (base's #44bd13 bar already gives 6.75:1), where the rim adds
   * nothing and just softens the silhouette.
   */
  rim?: boolean;
  /**
   * Accessible name. OMIT for decorative use beside a visible "Circuit Center"
   * wordmark — a title there makes a screen reader announce the brand twice.
   */
  title?: string;
  className?: string;
}

export default function Logo({
  size = 32,
  variant = 'badge',
  rim = true,
  title,
  className,
}: LogoProps) {
  const band = bandFor(variant, size);
  const [footTop, footBottom] = band.feet;
  // Scale the hairline with the drawing so it stays a hairline on screen: the
  // viewBox is 200 units wide however many pixels it renders at, so a fixed
  // stroke-width would be 4x heavier at 48px than at 180px.
  const rimWidth = (200 / size) * 1;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {band.plate && (
        <rect
          x={band.plate.inset}
          y={band.plate.inset}
          width={200 - band.plate.inset * 2}
          height={200 - band.plate.inset * 2}
          rx={band.plate.r}
          fill="#1a1f23"
        />
      )}
      {band.plate && rim && (
        // Drawn INSET by half the stroke so the hairline lands fully inside the
        // plate — a centred stroke would spill half its width outside the
        // silhouette and fringe against the backdrop.
        <rect
          x={band.plate.inset + rimWidth / 2}
          y={band.plate.inset + rimWidth / 2}
          width={200 - band.plate.inset * 2 - rimWidth}
          height={200 - band.plate.inset * 2 - rimWidth}
          rx={band.plate.r - rimWidth / 2}
          fill="none"
          stroke="rgba(255,255,255,0.14)"
          strokeWidth={rimWidth}
        />
      )}
      <path d={ARC} fill="none" stroke="#ffffff" strokeWidth={band.arc} strokeLinecap="round" />
      <path d={footTop} fill="#ffffff" />
      <path d={footBottom} fill="#ffffff" />
      {/* Capacitor plates: outer pair short, centre plate tall — the graduation
          is what reads as a component rather than three tally marks. */}
      <line x1="89" y1="86.5" x2="89" y2="113.5" stroke="#44bd13" strokeWidth={band.electrode} strokeLinecap="round" />
      <line x1="100.5" y1="79.5" x2="100.5" y2="120.5" stroke="#44bd13" strokeWidth={band.electrode} strokeLinecap="round" />
      <line x1="112" y1="86.5" x2="112" y2="113.5" stroke="#44bd13" strokeWidth={band.electrode} strokeLinecap="round" />
      {band.stem !== null && (
        <line x1="114" y1="100" x2="141" y2="100" stroke="#44bd13" strokeWidth={band.stem} strokeLinecap="round" />
      )}
    </svg>
  );
}
