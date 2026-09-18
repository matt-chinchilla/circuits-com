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
} as const;

/**
 * One supplier's visible badge. `key` is the catalogue key (`founder_badge_1`
 * or `founder_badge_2` today); there is one artwork, so an unknown key still
 * renders the pin rather than nothing.
 */
export interface BadgeLook {
  key: string;
  scheme: BadgeScheme;
  intensity: number;
  opacity: number;
  sparks: boolean;
}
