import { Link } from 'react-router-dom';
import Logo from '@shared/components/Logo';
import styles from './Footer.module.scss';

const FOOTER_LINKS = [
  { to: '/', label: 'Home' },
  { to: '/about', label: 'About' },
  { to: '/keyword', label: 'Sponsor a Keyword' },
  { to: '/contact', label: 'Contact' },
  { to: '/privacy', label: 'Privacy' },
  { to: '/terms', label: 'Terms' },
  // Payment processors check that an ad-supported site publishes what it will
  // and won't carry, and check that the policy is reachable rather than buried.
  { to: '/acceptable-use', label: 'Acceptable Use' },
];

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className={styles.inner}>
        <p className={styles.copyright}>
          {/* Decorative: the company name follows immediately in this same
              line, so naming the SVG would double it up for a screen reader. */}
          <Logo variant="badge" size={22} className={styles.copyrightMark} />
          © 2026 Circuit Center
        </p>
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
