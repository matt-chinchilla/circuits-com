import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Link, useLocation } from "react-router-dom";
import SearchBar from "./SearchBar";
import Logo from "@shared/components/Logo";
import BrowseDrawer, {
  loadBrowseDrawerBody,
  prefetchBrowseDrawerBody,
} from "./BrowseDrawer";
import styles from "./Navbar.module.scss";

// No "Home" entry on purpose: the brand mark to its left is already the
// home link, and a fifth item pushed this absolutely-positioned cluster into
// the absolutely-centered search bar between 1200 and ~1385px — the search
// input covered "Home" and swallowed the SEARCH button's clicks. The navbar
// pins its side content to the viewport edges (see CLAUDE.md), so the centre
// only stays clear while the sides stay narrow.
// "Advertise" (/pricing) folded into "Join" on 2026-08-14 — the staged Join
// page now carries the tiers, the board picker and the partners desk, so a
// separate entry would point two labels at one surface.
const NAV_LINKS = [
  { to: "/about", label: "About" },
  { to: "/join", label: "Join" },
  { to: "/contact", label: "Contact" },
];

const linkClassName = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.navLink} ${styles.active}` : styles.navLink;

export default function Navbar() {
  const location = useLocation();
  const isHome = location.pathname === "/";

  // BrowseDrawer state lives here because the burger (below) toggles it; the
  // drawer itself owns the scroll-lock/Esc/route-close machine and calls back
  // through onClose. It replaced the old mobile-only navMobileDrawer — the
  // browse drawer is the site's ONLY drawer, at every viewport.
  const [browseOpen, setBrowseOpen] = useState(false);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const closeBrowse = useCallback(() => setBrowseOpen(false), []);

  // Dialog focus contract: whichever path closed the drawer (X, scrim, Esc,
  // route change), focus returns to the burger that opened it.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !browseOpen) burgerRef.current?.focus();
    wasOpenRef.current = browseOpen;
  }, [browseOpen]);

  const onBurgerClick = () => {
    if (browseOpen) {
      setBrowseOpen(false);
      return;
    }
    // Open only once the body chunk is in hand: a failed import leaves the
    // page untouched (no empty drawer over a scrim), the loader resets
    // itself, and the next click retries the network — never a dead control.
    loadBrowseDrawerBody()
      .then(() => setBrowseOpen(true))
      .catch(() => {});
  };

  const burgerClass = browseOpen
    ? `${styles.browseBurger} ${styles.isOpen}`
    : styles.browseBurger;

  return (
    <header className={styles.header}>
      <div className={styles.topStrip}>
        <button
          type="button"
          ref={burgerRef}
          className={burgerClass}
          onClick={onBurgerClick}
          onMouseEnter={prefetchBrowseDrawerBody}
          aria-label={browseOpen ? "Close browse menu" : "Open browse menu"}
          aria-expanded={browseOpen}
          aria-controls="browse-drawer"
        >
          <span className={styles.browseBurgerLine} aria-hidden="true" />
          <span className={styles.browseBurgerLine} aria-hidden="true" />
          <span className={styles.browseBurgerLine} aria-hidden="true" />
        </button>
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
        </div>
      </div>

      <BrowseDrawer open={browseOpen} onClose={closeBrowse} />
    </header>
  );
}
