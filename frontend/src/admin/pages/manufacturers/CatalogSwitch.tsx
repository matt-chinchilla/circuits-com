// The centered console switch (spec L5 + synthesis R9/R10/R11) — Manufacturers
// <-> Leads for staff, and the two customer capability pairs.
//
// Two REAL ROUTES, not a ?view= param: TITLE_MAP and the admin ErrorBoundary
// are pathname-keyed, and two routes make the URL-param-absent gotcha
// unrepresentable. NavLink halves mean the URL and the switch can never
// disagree. Absolute-centered per the navbar pinned-edge pattern — a third
// child of a space-between row is NOT centered when the side tracks differ.
//
// Hidden entirely for demo sessions: the API refuses demo on every lead read,
// so offering the tab would only render a wall.
//
// The halves are a PROP because the customer console fronts its two route
// pairs with this same control (surface-map §1): `[Suppliers | My Supply]` and
// `[Manufacturers | My Manufacturing]`. Each caller passes only the halves the
// viewer holds a link for, and an account with a single capability gets no
// switch at all — there is nowhere to switch to. Passing nothing keeps the
// staff pair, so the Manufacturers and Leads lists render exactly as before.

import { NavLink } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';

import styles from './CatalogSwitch.module.scss';

export interface CatalogSwitchHalf {
  /**
   * An href for the mount being rendered — ALREADY through `consolePath`.
   * Resolved by the caller rather than here so each /admin path is translated
   * exactly once, at the one place it is spelled (see `accountPairs.ts`).
   */
  to: string;
  label: string;
  /** Hue veil worn while this half is the active one. Green unless stated. */
  tone?: 'green' | 'red';
}

const TONE_CLASS: Record<'green' | 'red', string> = {
  green: styles.halfGreen,
  red: styles.halfRed,
};

interface CatalogSwitchProps {
  halves?: CatalogSwitchHalf[];
  ariaLabel?: string;
}

export default function CatalogSwitch({ halves, ariaLabel = 'Catalog view' }: CatalogSwitchProps) {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();

  const shown = halves ?? [
    { to: consolePath('/admin/manufacturers'), label: 'Manufacturers', tone: 'green' as const },
    { to: consolePath('/admin/leads'), label: 'Leads', tone: 'red' as const },
  ];

  // One half is not a switch. Rendering it would be a control that cannot move.
  if (shown.length < 2) return null;

  return (
    <nav className={styles.switch} role="group" aria-label={ariaLabel}>
      {shown.map((half) => (
        <NavLink
          key={half.to}
          to={half.to}
          end
          className={({ isActive }) =>
            isActive
              ? `${styles.half} ${TONE_CLASS[half.tone ?? 'green']} ${styles.active}`
              : styles.half
          }
        >
          {half.label}
        </NavLink>
      ))}
    </nav>
  );
}
