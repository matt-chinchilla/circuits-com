import { NavLink } from 'react-router-dom';
import styles from './Navbar.module.scss';

const NAV_LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/about', label: 'About', end: false },
  { to: '/join', label: 'Join', end: false },
  { to: '/contact', label: 'Contact', end: false },
];

export default function Navbar() {
  return (
    <header className={styles.header}>
      <div className={styles.topStrip}>
        <div className={styles.inner}>
          <span className={styles.brand}>Circuits.com</span>
          <nav className={styles.nav} aria-label="Main navigation">
            {NAV_LINKS.map(({ to, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  [styles.navLink, isActive ? styles.active : ''].filter(Boolean).join(' ')
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
    </header>
  );
}
