import { useState, useEffect } from "react";
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

const drawerLinkClassName = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.navMobileLink} ${styles.active}` : styles.navMobileLink;

export default function Navbar() {
  const location = useLocation();
  const isHome = location.pathname === "/";
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const burgerClass = menuOpen
    ? `${styles.navBurger} ${styles.isOpen}`
    : styles.navBurger;
  const scrimClass = menuOpen
    ? `${styles.navMobileScrim} ${styles.isOpen}`
    : styles.navMobileScrim;
  const drawerClass = menuOpen
    ? `${styles.navMobileDrawer} ${styles.isOpen}`
    : styles.navMobileDrawer;

  return (
    <header className={styles.header}>
      <div className={styles.topStrip}>
        <Link to="/" className={styles.brand}>
          <span className={styles.brandDot} aria-hidden="true" />
          <span className={styles.brandSquare} aria-hidden="true" />
          Circuit Center
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
          <button
            type="button"
            className={burgerClass}
            onClick={() => setMenuOpen((v) => !v)}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            aria-expanded={menuOpen}
            aria-controls="nav-mobile-drawer"
          >
            <span className={styles.navBurgerLine} aria-hidden="true" />
            <span className={styles.navBurgerLine} aria-hidden="true" />
            <span className={styles.navBurgerLine} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        className={scrimClass}
        onClick={() => setMenuOpen(false)}
        aria-hidden="true"
      />
      <nav
        id="nav-mobile-drawer"
        className={drawerClass}
        aria-label="Mobile navigation"
        aria-hidden={!menuOpen}
      >
        <ul className={styles.navMobileList}>
          {NAV_LINKS.map(({ to, label }) => (
            <li key={to}>
              <NavLink
                to={to}
                end={to === "/"}
                className={drawerLinkClassName}
                onClick={() => setMenuOpen(false)}
                tabIndex={menuOpen ? 0 : -1}
              >
                <span>{label}</span>
                <span className={styles.navMobileArrow} aria-hidden="true">
                  ›
                </span>
              </NavLink>
            </li>
          ))}
        </ul>
        <div className={styles.navMobileFoot}>
          <span className={styles.navMobileFootBrand}>Circuit Center</span>
          <span className={styles.navMobileFootRev}>REV-A</span>
        </div>
      </nav>
    </header>
  );
}
