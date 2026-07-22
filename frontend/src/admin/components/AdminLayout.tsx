import { useState, useEffect, useRef } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Search, Bell, Plus, Menu, X } from 'lucide-react';
import { useAuth } from '@admin/contexts/AuthContext';
import { useDemo } from '@admin/contexts/DemoContext';
import Icon from '@shared/components/Icon';
import BellDropdown from '@admin/components/messages/BellDropdown';
import { adminApi } from '@admin/services/adminApi';
import {
  loadMessages,
  refreshMessages,
  unreadCount,
} from '@admin/services/messageStore';
import { Wizard } from '@admin/wizard';
import styles from './AdminLayout.module.scss';
import type { ReactNode } from 'react';

interface AdminLayoutProps {
  children: ReactNode;
  role?: 'admin' | 'company';
}

// Sidebar links use Phosphor Light names (v5 design handoff 2026-05-23).
// `badgeKey` opts the link into the dynamic-count badge — see useEffect
// below for the parts/suppliers/imports wiring.
type BadgeKey = 'parts' | 'suppliers' | 'imports';

interface SidebarLink {
  to: string;
  label: string;
  icon: string;
  badgeKey?: BadgeKey;
  adminOnly?: boolean;
  // Anchor hook for the guided-tour wizard. Falls through to NavLink as
  // data-tour="<value>" so flows can spotlight specific sidebar entries.
  tour?: string;
}

const CATALOG_LINKS: SidebarLink[] = [
  { to: '/admin', label: 'Dashboard', icon: 'gauge', tour: 'side-dashboard' },
  { to: '/admin/parts', label: 'Parts', icon: 'package', badgeKey: 'parts', tour: 'side-parts' },
  { to: '/admin/suppliers', label: 'Suppliers', icon: 'buildings', badgeKey: 'suppliers', tour: 'side-suppliers' },
  { to: '/admin/categories', label: 'Categories', icon: 'squares-four', adminOnly: true, tour: 'side-categories' },
  { to: '/admin/sponsors', label: 'Sponsors', icon: 'star', adminOnly: true, tour: 'side-sponsors' },
  { to: '/admin/reports', label: 'Reports', icon: 'chart-bar', tour: 'side-reports' },
];

const COMMS_LINKS: SidebarLink[] = [
  { to: '/admin/messages', label: 'Messages', icon: 'envelope', adminOnly: true, tour: 'side-messages' },
];

const SYSTEM_LINKS: SidebarLink[] = [
  { to: '/admin/import', label: 'Import Queue', icon: 'upload-simple', badgeKey: 'imports', tour: 'side-import' },
  { to: '/admin/settings', label: 'Settings', icon: 'gear-six', tour: 'side-settings' },
];

// Demo magnitudes per v5 design data.jsx (hand-tuned to feel believable
// against a real distributor catalog). Live mode reads stats from the API.
const DEMO_BADGES = { parts: 2_487_302, suppliers: 8, imports: 3 } as const;

function formatBadgeCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

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
  '/admin/messages': 'Messages',
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
  const navigate = useNavigate();
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [unread, setUnread] = useState(() => unreadCount());
  const [wiggle, setWiggle] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [partsCount, setPartsCount] = useState(0);
  const [suppliersCount, setSuppliersCount] = useState(0);
  const prevUnread = useRef(unread);

  // Sidebar badge counts. Demo mode = seeded magnitudes; live mode hits
  // /api/dashboard/stats. Import-queue is always 0 in live mode (no
  // backend yet) — badge hides when count is 0. The `cancelled` closure
  // guards against a rapid demoMode toggle stomping demo magnitudes with
  // a late API response.
  useEffect(() => {
    if (demoMode) {
      setPartsCount(DEMO_BADGES.parts);
      setSuppliersCount(DEMO_BADGES.suppliers);
      return undefined;
    }
    let cancelled = false;
    adminApi
      .getStats()
      .then((s) => {
        if (cancelled) return;
        setPartsCount(s.parts_count ?? 0);
        setSuppliersCount(s.suppliers_count ?? 0);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[AdminLayout] dashboard stats fetch failed', err);
        setPartsCount(0);
        setSuppliersCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [demoMode]);

  // Refresh unread count when route changes — covers list/detail navigation
  // that flips messages from new → read. Also auto-closes the mobile drawer.
  // On every pathname transition (including initial mount), pull fresh
  // messages from the API so the bell-count stays in sync with the DB even
  // when the admin user is on a non-Messages page.
  useEffect(() => {
    refreshMessages().then(() => {
      setUnread(unreadCount());
    });
    setUnread(unreadCount()); // optimistic read from cache so the badge doesn't flicker
    setMenuOpen(false);
  }, [location.pathname]);

  // Body scroll lock while mobile drawer is open. Cleanup restores prev value.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [menuOpen]);

  // Esc closes the mobile drawer (listener only attached while open).
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // Bell wiggle animation when an unread message appears (badge increments).
  useEffect(() => {
    if (unread > prevUnread.current) {
      setWiggle(true);
      const t = setTimeout(() => setWiggle(false), 1000);
      return () => clearTimeout(t);
    }
    prevUnread.current = unread;
    return undefined;
  }, [unread]);

  // ⌘K / Ctrl+K opens the topbar search; Esc closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape') {
        setSearchOpen(false);
        setBellOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const catalogVisible =
    role === 'admin' ? CATALOG_LINKS : CATALOG_LINKS.filter((l) => !l.adminOnly);
  const commsVisible =
    role === 'admin' ? COMMS_LINKS : COMMS_LINKS.filter((l) => !l.adminOnly);

  const initials = (user?.username || 'AD').slice(0, 2).toUpperCase();
  const title = pageTitle(location.pathname);

  function badgeValue(key: BadgeKey | undefined): string | null {
    if (!key) return null;
    if (key === 'parts') return partsCount > 0 ? formatBadgeCount(partsCount) : null;
    if (key === 'suppliers') return suppliersCount > 0 ? String(suppliersCount) : null;
    if (key === 'imports') {
      // No live import-queue API yet; show only in demo mode, hide otherwise.
      return demoMode ? String(DEMO_BADGES.imports) : null;
    }
    return null;
  }

  function renderLink(link: SidebarLink) {
    const showUnreadBadge = link.to === '/admin/messages' && unread > 0;
    const dynamicBadge = badgeValue(link.badgeKey);
    return (
      <NavLink
        key={link.to}
        to={link.to}
        end={link.to === '/admin'}
        data-tour={link.tour}
        className={({ isActive }) => `${styles.sideItem} ${isActive ? styles.active : ''}`}
      >
        <Icon name={link.icon} />
        <span>{link.label}</span>
        {showUnreadBadge && (
          <span className={`${styles.sideBadge} ${styles.unreadBadge}`}>{unread}</span>
        )}
        {!showUnreadBadge && dynamicBadge && (
          <span className={styles.sideBadge}>{dynamicBadge}</span>
        )}
      </NavLink>
    );
  }

  const sideClass = menuOpen ? `${styles.side} ${styles.isOpen}` : styles.side;
  const scrimClass = menuOpen
    ? `${styles.sideScrim} ${styles.isOpen}`
    : styles.sideScrim;

  return (
    <div className={styles.admin}>
      <aside
        id="admin-sidebar"
        className={sideClass}
        aria-label="Admin navigation"
        aria-hidden={!menuOpen ? undefined : false}
      >
        <button
          type="button"
          className={styles.sideClose}
          onClick={() => setMenuOpen(false)}
          aria-label="Close menu"
        >
          <X size={16} strokeWidth={2} />
        </button>
        <Link to="/admin" className={styles.sideBrand}>
          <div className={styles.sideBrandMark}>C</div>
          <div>
            <div className={styles.sideBrandName}>Circuit Center</div>
            <div className={styles.sideBrandRole}>Admin</div>
          </div>
        </Link>

        <div className={styles.sideGroupLabel}>Catalog</div>
        {catalogVisible.map(renderLink)}

        {commsVisible.length > 0 && (
          <>
            <div className={styles.sideGroupLabel}>Communications</div>
            {commsVisible.map(renderLink)}
          </>
        )}

        <div className={styles.sideGroupLabel}>System</div>
        {SYSTEM_LINKS.map(renderLink)}

        <div className={styles.sideSpacer} />

        <div className={styles.sideBottom}>
          <Link to="/" className={`${styles.sideItem} ${styles.subtle}`}>
            <Icon name="arrow-square-out" />
            <span>Back to Site</span>
          </Link>
          <button
            type="button"
            className={`${styles.sideItem} ${styles.subtle} ${styles.sideItemBtn}`}
            onClick={() => setSignOutOpen(true)}
          >
            <Icon name="sign-out" />
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

      <div
        className={scrimClass}
        onClick={() => setMenuOpen(false)}
        aria-hidden="true"
      />

      <div className={styles.main}>
        <header className={styles.topbar}>
          <button
            type="button"
            data-tour="open-mobile-menu"
            className={styles.topbarBurger}
            onClick={() => setMenuOpen(true)}
            aria-label="Open menu"
            aria-expanded={menuOpen}
            aria-controls="admin-sidebar"
          >
            <Menu size={18} strokeWidth={2} />
          </button>
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

            <div className={styles.bellWrap}>
              <button
                type="button"
                className={`${styles.iconBtn} ${wiggle ? styles.bellWiggle : ''}`}
                title="Notifications"
                aria-label="Notifications"
                onClick={() => setBellOpen((b) => !b)}
              >
                <Bell size={16} strokeWidth={2} />
                {unread > 0 && (
                  <span className={styles.bellBadge}>{unread > 9 ? '9+' : unread}</span>
                )}
              </button>
              {bellOpen && (
                <BellDropdown
                  messages={loadMessages()}
                  unreadCount={unread}
                  onClose={() => setBellOpen(false)}
                  onOpenAll={() => {
                    setBellOpen(false);
                    navigate('/admin/messages');
                  }}
                  onOpen={(id) => {
                    setBellOpen(false);
                    navigate(`/admin/messages/${id}`);
                  }}
                />
              )}
            </div>

            <Link to="/admin/parts/new" className={`${styles.btn} ${styles.btnPrimary}`}>
              <Plus size={15} strokeWidth={2} />
              <span className={styles.btnLabel}>New Part</span>
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

      {/* Guided-tour wizard. Mounts as a sibling of {children} so it lives
          inside the React Router context (useNavigate/useLocation work) but
          outside the page's scroll container, so the FAB stays pinned. */}
      <Wizard />
    </div>
  );
}
