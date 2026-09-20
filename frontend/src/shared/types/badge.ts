/**
 * The badge LOOK — the per-supplier fire settings that ride on every payload
 * that used to carry a bare `founder` boolean (migration 055).
 *
 * This is the client half of `api/app/services/badges.py`: the schemes and the
 * two numeric ranges are mirrored from the model's constants, so a change on
 * one side has to be made on the other. It lives in `@shared` because the
 * public sponsor boards and the admin/customer badge editor both read it, and
 * admin may not import public.
 *
 * The ranges carry the `default` the server stamps as well as the slider
 * bounds, so an editor never has to invent one.
 */
export const BADGE_SCHEMES = [
  'red',
  'orange',
  'yellow',
  'green',
  'blue',
  'indigo',
  'violet',
  'white',
  'black',
] as const;

export type BadgeScheme = (typeof BADGE_SCHEMES)[number];

export const BADGE_RANGES = {
  intensity: { min: 0.3, max: 2, step: 0.1, default: 1 },
  opacity: { min: 0.2, max: 1, step: 0.05, default: 0.75 },
  /** Pulsing badge only: seconds per cycle (migration 056). */
  speed: { min: 1, max: 6, step: 0.1, default: 2.6 },
} as const;

/** The catalogue key that renders the PULSING artwork (`<glow-badge>`); every
 *  other key renders the burning pin. Mirrors `FOUNDER_BADGE_2` in
 *  `api/app/models/badge.py`. */
export const PULSE_BADGE_KEY = 'founder_badge_2';

/** Which tools the editor shows for a key: the fire's sliders or the pulse's. */
export function badgeArtwork(key: string): 'fire' | 'pulse' {
  return key === PULSE_BADGE_KEY ? 'pulse' : 'fire';
}

/**
 * One supplier's visible badge. `key` is the catalogue key: `founder_badge_2`
 * is the pulsing artwork (scheme + `intensity` as its glow + `speed`), any
 * other key is the burning pin (scheme/intensity/opacity/sparks). Every field
 * is stored for every holding so switching artwork and back loses nothing.
 */
export interface BadgeLook {
  key: string;
  scheme: BadgeScheme;
  intensity: number;
  opacity: number;
  sparks: boolean;
  speed: number;
}
