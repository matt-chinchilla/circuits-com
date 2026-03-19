import { NavLink, Link } from 'react-router-dom';
import SearchBar from './SearchBar';
import styles from './Navbar.module.scss';

const NAV_LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/about', label: 'About', end: false },
  { to: '/join', label: 'Join', end: false },
  { to: '/contact', label: 'Contact', end: false },
  { to: '/search', label: 'Search', end: false },
];

export default function Navbar() {
  return (
    <header className={styles.header}>
      <div className={styles.topStrip}>
        <div className={styles.inner}>
          <Link to="/" className={styles.brand}>Circuits.com</Link>
          <div className={styles.navSearch}>
            <SearchBar variant="nav" />
          </div>
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
