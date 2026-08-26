// The Manufacturers <-> Leads centered switch (spec L5 + synthesis R9/R10/R11).
//
// Two REAL ROUTES, not a ?view= param: TITLE_MAP and the admin ErrorBoundary
// are pathname-keyed, and two routes make the URL-param-absent gotcha
// unrepresentable. NavLink halves mean the URL and the switch can never
// disagree. Absolute-centered per the navbar pinned-edge pattern — a third
// child of a space-between row is NOT centered when the side tracks differ.
//
// Hidden entirely for demo sessions: the API refuses demo on every lead read,
// so offering the tab would only render a wall.

import { NavLink } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';

import styles from './CatalogSwitch.module.scss';

export default function CatalogSwitch() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();

  return (
    <nav className={styles.switch} role="group" aria-label="Catalog view">
      <NavLink
        to={consolePath('/admin/manufacturers')}
        end
        className={({ isActive }) =>
          isActive ? `${styles.half} ${styles.halfGreen} ${styles.active}` : styles.half
        }
      >
        Manufacturers
      </NavLink>
      <NavLink
        to={consolePath('/admin/leads')}
        end
        className={({ isActive }) =>
          isActive ? `${styles.half} ${styles.halfRed} ${styles.active}` : styles.half
        }
      >
        Leads
      </NavLink>
    </nav>
  );
}
