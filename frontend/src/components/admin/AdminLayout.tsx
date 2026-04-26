import { useState, useEffect } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Package,
  Building2,
  Layers,
  Star,
  BarChart3,
  Upload,
  Settings as SettingsIcon,
  ExternalLink,
  LogOut,
  Search,
  Bell,
  Plus,
} from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useDemo } from '../../contexts/DemoContext';
import styles from './AdminLayout.module.scss';
import type { ReactNode, ComponentType } from 'react';

interface AdminLayoutProps {
  children: ReactNode;
  role?: 'admin' | 'company';
}

interface SidebarLink {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  badge?: string;
  adminOnly?: boolean;
}

// Two grouped sections per the 2026-04-25 design import — Catalog (data
// surfaces) above the System group (operations) for visual hierarchy.
const CATALOG_LINKS: SidebarLink[] = [
  { to: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/admin/parts', label: 'Parts', icon: Package },
  { to: '/admin/suppliers', label: 'Suppliers', icon: Building2 },
  { to: '/admin/categories', label: 'Categories', icon: Layers, adminOnly: true },
  { to: '/admin/sponsors', label: 'Sponsors', icon: Star, adminOnly: true },
  { to: '/admin/reports', label: 'Reports', icon: BarChart3 },
];

const SYSTEM_LINKS: SidebarLink[] = [
  { to: '/admin/import', label: 'Import Queue', icon: Upload },
  { to: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];

// Route → page-title map (drives the topbar h1). Falls back to "Admin" for
// unmatched routes; dynamic id-style segments (/admin/parts/:id, etc.) are
// handled by the regex branches.
const TITLE_MAP: Record<string, string> = {
  '/admin': 'Dashboard',
  '/admin/parts': 'Parts',
  '/admin/parts/new': 'New Part',
  '/admin/suppliers': 'Suppliers',
  '/admin/suppliers/new': 'New Supplier',
  '/admin/categories': 'Categories',
  '/admin/sponsors': 'Sponsors',
  '/admin/sponsors/new': 'New Sponsor',
  '/admin/reports': 'Reports',
  '/admin/import': 'Import Queue',
  '/admin/settings': 'Settings',
};

function pageTitle(pathname: string): string {
  if (TITLE_MAP[pathname]) return TITLE_MAP[pathname];
  // /admin/<entity>/<id>/edit
  if (/^\/admin\/(\w+)\/[\w-]+\/edit$/.test(pathname)) {
    const m = pathname.match(/^\/admin\/(\w+)\//);
    if (m) return `Edit ${m[1].replace(/s$/, '').replace(/^./, (c) => c.toUpperCase())}`;
  }
  // /admin/<entity>/<id>
  if (/^\/admin\/(\w+)\/[\w-]+$/.test(pathname)) {
    const m = pathname.match(/^\/admin\/(\w+)\//);
    if (m) return m[1].replace(/^./, (c) => c.toUpperCase()).replace(/s$/, ' Detail');
  }
  return 'Admin';
}

interface SignOutModalProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function SignOutModal({ open, onConfirm, onCancel }: SignOutModalProps) {
  if (!open) return null;
  return (
    <div className={styles.modalBackdrop} onClick={onCancel}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.modalTitle}>Sign out of admin?</h3>
        <p className={styles.modalBody}>
          You&rsquo;ll need to sign in again to access the admin console.
        </p>
        <div className={styles.modalActions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnGhost}`}
            onClick={onCancel}
          >
            Stay signed in
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            onClick={onConfirm}
          >
            <LogOut size={15} strokeWidth={2} />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AdminLayout({ children, role = 'admin' }: AdminLayoutProps) {
  const { user, logout } = useAuth();
  const { demoMode, toggleDemo } = useDemo();
  const location = useLocation();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  // ⌘K / Ctrl+K opens the topbar search; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape') {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const catalogVisible =
    role === 'admin' ? CATALOG_LINKS : CATALOG_LINKS.filter((l) => !l.adminOnly);

  const initials = (user?.username || 'AD').slice(0, 2).toUpperCase();
  const title = pageTitle(location.pathname);

  function renderLink(link: SidebarLink) {
    const Icon = link.icon;
    return (
      <NavLink
        key={link.to}
        to={link.to}
        end={link.to === '/admin'}
        className={({ isActive }) => `${styles.sideItem} ${isActive ? styles.active : ''}`}
      >
        <Icon size={18} strokeWidth={2} />
        <span>{link.label}</span>
        {link.badge && <span className={styles.sideBadge}>{link.badge}</span>}
      </NavLink>
    );
  }

  return (
    <div className={styles.admin}>
      <aside className={styles.side}>
        <Link to="/admin" className={styles.sideBrand}>
          <div className={styles.sideBrandMark}>C</div>
          <div>
            <div className={styles.sideBrandName}>Circuits.com</div>
            <div className={styles.sideBrandRole}>Admin</div>
          </div>
        </Link>

        <div className={styles.sideGroupLabel}>Catalog</div>
        {catalogVisible.map(renderLink)}

        <div className={styles.sideGroupLabel}>System</div>
        {SYSTEM_LINKS.map(renderLink)}

        <div className={styles.sideSpacer} />

        <div className={styles.sideBottom}>
          <Link to="/" className={`${styles.sideItem} ${styles.subtle}`}>
            <ExternalLink size={18} strokeWidth={2} />
            <span>Back to Site</span>
          </Link>
          <button
            type="button"
            className={`${styles.sideItem} ${styles.subtle} ${styles.sideItemBtn}`}
            onClick={() => setSignOutOpen(true)}
          >
            <LogOut size={18} strokeWidth={2} />
            <span>Sign Out</span>
          </button>
        </div>

        <div className={styles.sideProfile}>
          <div className={styles.sideAvatar}>{initials}</div>
          <div>
            <div className={styles.sideUserName}>{user?.username || 'Admin'}</div>
            <div className={styles.sideUserRole}>U1 · {user?.role || 'admin'}</div>
          </div>
        </div>
      </aside>

      <div className={styles.main}>
        <header className={styles.topbar}>
          <h1 className={styles.pageTitle}>{title}</h1>

          <div className={styles.topbarMid}>
            {searchOpen ? (
              <div className={`${styles.topbarSearch} ${styles.open}`}>
                <Search size={15} strokeWidth={2} />
                <input
                  autoFocus
                  placeholder="Search parts, suppliers, SKUs…"
                  onBlur={() => setSearchOpen(false)}
                />
                <kbd>ESC</kbd>
              </div>
            ) : (
              <button
                type="button"
                className={styles.topbarSearchTrigger}
                onClick={() => setSearchOpen(true)}
              >
                <Search size={14} strokeWidth={2} />
                <span>Search&hellip;</span>
                <kbd>⌘K</kbd>
              </button>
            )}
          </div>

          <div className={styles.topbarRight}>
            <button
              type="button"
              role="switch"
              aria-checked={demoMode}
              className={styles.demoToggle}
              onClick={toggleDemo}
              title="Toggle between hypothetical (demo) data and live production data"
            >
              <span className={styles.demoLabel}>Demo Data</span>
              <span className={`${styles.demoSwitch} ${demoMode ? styles.on : styles.off}`}>
                <span className={styles.demoKnob} />
              </span>
              <span className={`${styles.demoState} ${demoMode ? styles.on : styles.off}`}>
                {demoMode ? 'ON' : 'OFF'}
              </span>
            </button>

            <button type="button" className={styles.iconBtn} title="Notifications" aria-label="Notifications">
              <Bell size={16} strokeWidth={2} />
              <span className={styles.iconBtnDot} />
            </button>

            <Link to="/admin/parts/new" className={`${styles.btn} ${styles.btnPrimary}`}>
              <Plus size={15} strokeWidth={2} />
              New Part
            </Link>
          </div>
        </header>

        <div className={styles.content}>{children}</div>
      </div>

      <SignOutModal
        open={signOutOpen}
        onConfirm={() => {
          setSignOutOpen(false);
          logout();
        }}
        onCancel={() => setSignOutOpen(false)}
      />
    </div>
  );
}
