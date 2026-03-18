import { Link } from 'react-router-dom';
import styles from './Footer.module.scss';

const FOOTER_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/about', label: 'About' },
  { to: '/contact', label: 'Contact' },
  { to: '/privacy', label: 'Privacy' },
];

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <p className={styles.copyright}>© 2026 Circuits.com</p>
        <nav className={styles.links} aria-label="Footer navigation">
          {FOOTER_LINKS.map(({ to, label }) => (
            <Link key={to} to={to} className={styles.link}>
              {label}
            </Link>
          ))}
        </nav>
      </div>
    </footer>
  );
}
