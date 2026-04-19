import { NavLink, Link, useLocation } from "react-router-dom";
import SearchBar from "./SearchBar";
import styles from "./Navbar.module.scss";

const NAV_LINKS = [
  { to: "/", label: "Home" },
  { to: "/about", label: "About" },
  { to: "/join", label: "Join" },
  { to: "/contact", label: "Contact" },
];

const linkClassName = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.navLink} ${styles.active}` : styles.navLink;

export default function Navbar() {
  const isHome = useLocation().pathname === "/";

  return (
    <header className={styles.header}>
      <div className={styles.topStrip}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandDot} aria-hidden="true" />
          Circuits.com
          <span className={styles.brandSuffix} aria-hidden="true">
            / REV-A
          </span>
        </Link>
        {!isHome && (
          <div className={styles.navSearch}>
            <SearchBar variant="nav" />
          </div>
        )}
        <div className={styles.navRight}>
          <nav className={styles.navLinks} aria-label="Main navigation">
            {NAV_LINKS.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                end={to === "/"}
                className={linkClassName}
              >
                {label}
              </NavLink>
            ))}
          </nav>
          <Link to="/admin/login" className={styles.loginBtn}>
            LOGIN
          </Link>
        </div>
      </div>
    </header>
  );
}
