import { NavLink, Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import styles from './AdminLayout.module.scss';
import type { ReactNode } from 'react';

interface AdminLayoutProps {
  children: ReactNode;
  role?: 'admin' | 'company';
}

interface SidebarLink {
  to: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
}

const SIDEBAR_LINKS: SidebarLink[] = [
  { to: '/admin', label: 'Dashboard', icon: '\u{1F4CA}' },
  { to: '/admin/suppliers', label: 'Suppliers', icon: '\u{1F3ED}' },
  { to: '/admin/parts', label: 'Parts', icon: '\u{1F9F0}' },
  { to: '/admin/import', label: 'Import', icon: '\u{1F4E5}' },
  { to: '/admin/reports', label: 'Reports', icon: '\u{1F4C8}' },
  { to: '/admin/categories', label: 'Categories', icon: '\u{1F4C2}', adminOnly: true },
  { to: '/admin/sponsors', label: 'Sponsors', icon: '\u2B50', adminOnly: true },
];

export default function AdminLayout({ children, role = 'admin' }: AdminLayoutProps) {
  const { user, logout } = useAuth();

  const visibleLinks = role === 'admin'
    ? SIDEBAR_LINKS
    : SIDEBAR_LINKS.filter((link) => !link.adminOnly);

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <span className={styles.logo}>{'\u26A1'}</span>
          <span className={styles.title}>Circuits Control Center</span>
        </div>
        <nav className={styles.nav}>
          {visibleLinks.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/admin'}
              className={({ isActive }) =>
                `${styles.navLink} ${isActive ? styles.active : ''}`
              }
            >
              <span className={styles.navIcon}>{link.icon}</span>
              <span className={styles.navLabel}>{link.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className={styles.sidebarFooter}>
          <div className={styles.userInfo}>
            <span className={styles.userName}>{user?.username ?? 'Admin'}</span>
            <span className={styles.userRole}>{user?.role ?? 'admin'}</span>
          </div>
          <Link to="/" className={styles.backToSiteBtn}>
            <span className={styles.backArrow} aria-hidden="true">←</span>
            Back to Site
          </Link>
          <button className={styles.logoutBtn} onClick={logout}>
            Sign Out
          </button>
        </div>
      </aside>
      <main className={styles.main}>
        {children}
      </main>
    </div>
  );
}
