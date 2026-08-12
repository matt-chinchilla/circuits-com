import { useState, useEffect } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import SearchBar from "./SearchBar";
import Logo from "@shared/components/Logo";
import styles from "./Navbar.module.scss";

// No "Home" entry on purpose: the brand mark to its left is already the
// home link, and a fifth item pushed this absolutely-positioned cluster into
// the absolutely-centered search bar between 1200 and ~1385px — the search
// input covered "Home" and swallowed the SEARCH button's clicks. The navbar
// pins its side content to the viewport edges (see CLAUDE.md), so the centre
// only stays clear while the sides stay narrow.
const NAV_LINKS = [
  { to: "/about", label: "About" },
  { to: "/join", label: "Join" },
  { to: "/pricing", label: "Advertise" },
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
          {/* Badge, not bare mark: the rounded square is part of the logo and
              now shows on every theme. Its hairline rim is what makes the plate
              read on the dark bars, where the fill alone is ~1.1:1 against
              them. No `title` — the wordmark sits right beside it, and naming
              the SVG too would make a screen reader say the brand twice. */}
          <Logo variant="badge" size={26} className={styles.brandMark} />
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
