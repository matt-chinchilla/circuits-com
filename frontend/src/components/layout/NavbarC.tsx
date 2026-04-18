import { NavLink, Link } from "react-router-dom";
import styles from "./NavbarC.module.scss";

const NAV_LINKS = [
  { to: "/", label: "Home" },
  { to: "/about", label: "About" },
  { to: "/join", label: "Join" },
  { to: "/contact", label: "Contact" },
];

const linkClassName = ({ isActive }: { isActive: boolean }) =>
  isActive ? `${styles.navLink} ${styles.active}` : styles.navLink;

export default function NavbarC() {
  return (
    <header className={styles.header}>
      <div className={styles.topStrip}>
        <div className={styles.inner}>
          <Link to="/" className={styles.brand}>
            Circuits.com
          </Link>
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
      </div>
    </header>
  );
}
