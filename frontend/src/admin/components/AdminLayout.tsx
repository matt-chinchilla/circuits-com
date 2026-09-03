import { useState, useEffect, useRef } from 'react';
import { NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import { LogOut, Search, Bell, Plus, Menu, X, Sun, Moon } from 'lucide-react';
import { useAuth } from '@admin/contexts/AuthContext';
import { useDemo } from '@admin/contexts/DemoContext';
import { useAdminTheme } from '@admin/contexts/AdminThemeContext';
import Icon from '@shared/components/Icon';
import BellDropdown from '@admin/components/messages/BellDropdown';
import PresenceBubbles from '@admin/components/PresenceBubbles';
import { adminApi } from '@admin/services/adminApi';
import { accountApi } from '@admin/services/accountApi';
import { consoleBase, canonicalPath, mountPath } from '@admin/services/consolePath';
import {
  loadMessages,
  refreshMessages,
  unreadCount,
} from '@admin/services/messageStore';
import { Wizard } from '@admin/wizard';
import Logo from '@shared/components/Logo';
import styles from './AdminLayout.module.scss';
// Liquid-glass utility classes (global, static) — see styles/LIQUID-GLASS.md.
// Side-effect import for admin pages that consume .a-glass-*; the chrome
// itself (topbar / control pill / modal, 2026-07-31) consumes the --a-glass*
// tokens directly in AdminLayout.module.scss.
import '@admin/styles/glass.scss';
import type { ReactNode } from 'react';

interface AdminLayoutProps {
  children: ReactNode;
}

// Sidebar links use Phosphor Light names (v5 design handoff 2026-05-23).
// `badgeKey` opts the link into the dynamic-count badge — see useEffect
// below for the parts/suppliers/imports wiring.
type BadgeKey = 'parts' | 'suppliers' | 'imports' | 'manufacturers';

interface SidebarLink {
  to: string;
  label: string;
  icon: string;
  badgeKey?: BadgeKey;
  // Anchor hook for the guided-tour wizard. Falls through to NavLink as
  // data-tour="<value>" so flows can spotlight specific sidebar entries.
  tour?: string;
}

// STAFF sidebar. The customer's is built from capability instead — see
// customerLinks() below, which is a different list rather than a filter of
// this one: every entry here is a staff surface (require_staff routes, our own
// finances, our own CRM), so "hide some of them" was never the right shape.
const CATALOG_LINKS: SidebarLink[] = [
  { to: '/admin', label: 'Dashboard', icon: 'gauge', tour: 'side-dashboard' },
  { to: '/admin/parts', label: 'Parts', icon: 'package', badgeKey: 'parts', tour: 'side-parts' },
  { to: '/admin/suppliers', label: 'Suppliers', icon: 'buildings', badgeKey: 'suppliers', tour: 'side-suppliers' },
  { to: '/admin/manufacturers', label: 'Manufacturers', icon: 'factory', badgeKey: 'manufacturers' },
  // The registered-account roster. Staff-only data (require_staff).
  { to: '/admin/users', label: 'Users', icon: 'users-three' },
  { to: '/admin/categories', label: 'Categories', icon: 'squares-four', tour: 'side-categories' },
  { to: '/admin/sponsors', label: 'Sponsors', icon: 'star', tour: 'side-sponsors' },
  // Operating costs — the other half of the dashboard P&L. Internal finance,
  // never anything a customer login should see.
  { to: '/admin/expenses', label: 'Expenses', icon: 'receipt', tour: 'side-expenses' },
  { to: '/admin/reports', label: 'Reports', icon: 'chart-bar', tour: 'side-reports' },
];

const COMMS_LINKS: SidebarLink[] = [
  { to: '/admin/messages', label: 'Messages', icon: 'envelope', tour: 'side-messages' },
];

const SYSTEM_LINKS: SidebarLink[] = [
  { to: '/admin/import', label: 'Import Queue', icon: 'upload-simple', badgeKey: 'imports', tour: 'side-import' },
  { to: '/admin/settings', label: 'Settings', icon: 'gear-six', tour: 'side-settings' },
];

/**
 * The CUSTOMER sidebar, built from the two capability links (spec §1).
 *
 * An account's nature is the links it holds, never a type: `supplier_id` set
 * makes it a distributor, `manufacturer_id` set makes it a manufacturer, BOTH
 * set is the normal case for the largest players, and NEITHER is a free
 * browsing account. So the two flags are read independently and the free
 * account is a real, supported answer — it gets the five links that mean
 * something for anybody and no pretend company pages.
 *
 * The two PAIRS are `[Suppliers | My Supply]` and
 * `[Manufacturers | My Manufacturing]`, each fronted by CatalogSwitch on the
 * page itself. One sidebar entry per pair, named for the route it actually
 * opens — an entry that opened a different page than its label promises is the
 * collision the split routes exist to prevent. When the account holds both
 * links the entry lands on the LIST half and the switch reaches the other; the
 * ternary that picks it is not the forbidden `elif`, because neither half is
 * hidden by the other — only one of them is the landing page.
 *
 * The last three are for EVERY customer, capability or not:
 *
 *  - Sponsors was supplier-only, on the reasoning that `sponsors.supplier_id`
 *    is NOT NULL so a maker cannot hold a placement. True, and not a reason to
 *    hide the page: CustomerSponsorsPage says exactly that to a manufacturer
 *    and shows a free account what a placement is. Hiding it meant the accounts
 *    most likely to BUY one had no door to it.
 *  - Reports is a different page from the staff one (CustomerReportsPage), over
 *    /api/account endpoints only.
 *  - Expenses is the customer's OWN book — their `expenses` rows, never the
 *    company's, which the staff list reads as `user_id IS NULL`.
 *
 * Never here, for anyone: Users, Leads, Import Queue. Those are staff surfaces
 * behind require_staff routes.
 */
function customerLinks(isSupplier: boolean, isManufacturer: boolean): {
  catalog: SidebarLink[];
  comms: SidebarLink[];
} {
  const catalog: SidebarLink[] = [
    { to: '/admin', label: 'Dashboard', icon: 'gauge' },
    { to: '/admin/parts', label: 'Parts', icon: 'package', badgeKey: 'parts' },
    { to: '/admin/categories', label: 'Categories', icon: 'squares-four' },
  ];

  if (isSupplier || isManufacturer) {
    // Pair A. /suppliers is "distributors selling my products" and needs the
    // manufacturer link; /my-supply is their own distributor page.
    catalog.push(
      isManufacturer
        ? { to: '/admin/suppliers', label: 'Suppliers', icon: 'buildings' }
        : { to: '/admin/my-supply', label: 'My Supply', icon: 'buildings' },
    );
    // Pair B, the same join read the other way: /manufacturers is "makers
    // whose products I sell" and needs the supplier link.
    catalog.push(
      isSupplier
        ? { to: '/admin/manufacturers', label: 'Manufacturers', icon: 'factory' }
        : { to: '/admin/my-manufacturing', label: 'My Manufacturing', icon: 'factory' },
    );
  }

  catalog.push(
    { to: '/admin/sponsors', label: 'Sponsors', icon: 'star' },
    { to: '/admin/reports', label: 'Reports', icon: 'chart-bar' },
    { to: '/admin/expenses', label: 'Expenses', icon: 'receipt' },
  );

  return {
    catalog,
    comms: [{ to: '/admin/messages', label: 'Messages', icon: 'envelope' }],
  };
}

// The customer's System group. Import Queue is staff-only (the feed runs are
// ours to spend), so Settings is the whole of it.
const CUSTOMER_SYSTEM_LINKS: SidebarLink[] = [
  { to: '/admin/settings', label: 'Settings', icon: 'gear-six' },
];

// Demo magnitudes per v5 design data.jsx (hand-tuned to feel believable
// against a real distributor catalog). Live mode reads stats from the API.
const DEMO_BADGES = { parts: 2_487_302, suppliers: 8, imports: 3, manufacturers: 0 } as const;

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
  '/admin/manufacturers': 'Manufacturers',
  '/admin/users': 'Users',
  '/admin/manufacturers/new': 'New Manufacturer',
  '/admin/leads': 'Leads',
  '/admin/suppliers/new': 'New Supplier',
  '/admin/categories': 'Categories',
  '/admin/sponsors': 'Sponsors',
  '/admin/sponsors/new': 'New Sponsor',
  '/admin/expenses': 'Expenses',
  '/admin/expenses/new': 'New Expense',
  '/admin/reports': 'Reports',
  '/admin/messages': 'Messages',
  // The customer console's two "my own company" routes. Neither matches the
  // id-shaped regex fallbacks below (a hyphen is not \w), so without these the
  // topbar would title them "Admin".
  '/admin/my-supply': 'My Supply',
  '/admin/my-manufacturing': 'My Manufacturing',
  '/admin/import': 'Import Queue',
  '/admin/settings': 'Settings',
};

function pageTitle(rawPathname: string): string {
  const pathname = canonicalPath(rawPathname);
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

export default function AdminLayout({ children }: AdminLayoutProps) {
  // Who is looking is read from the context, not threaded down as a prop:
  // App.tsx mounts this same component at both /admin and /account, and a prop
  // is one more place the two mounts could be told apart differently.
  const { user, logout, isCustomer, isReadOnly, account } = useAuth();
  const { demoMode, toggleDemo } = useDemo();
  const { theme, toggleTheme } = useAdminTheme();
  const location = useLocation();
  const navigate = useNavigate();
  // Which mount is rendering — /admin for staff, /account for customers.
  const base = consoleBase(location.pathname);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  // messageStore's cache is the STAFF inbox and survives a sign-out on the
  // same tab, so seeding from it would flash a colleague's unread count in a
  // customer's badge before their own fetch lands.
  const [unread, setUnread] = useState(() => (isCustomer ? 0 : unreadCount()));
  const [wiggle, setWiggle] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [partsCount, setPartsCount] = useState(0);
  const [suppliersCount, setSuppliersCount] = useState(0);
  const [manufacturersCount, setManufacturersCount] = useState(0);
  const prevUnread = useRef(unread);

  // Capability, read INDEPENDENTLY — both links set is the normal case and
  // neither set is the free browsing account. `=== true` because the fields
  // are optional on a body that may predate them, and an absent flag must
  // read as "no link", never as truthy.
  const isSupplier = isCustomer && account?.is_supplier === true;
  const isManufacturer = isCustomer && account?.is_manufacturer === true;

  // The customer's own parts count. /api/dashboard/stats is require_staff and
  // would 403 at them on every page, and demo magnitudes are staff-facing
  // fiction that could never be a customer's data — so this is a different
  // endpoint, not the same one with a filter. The other three badges have no
  // account-scoped source at all and are simply absent from their sidebar.
  useEffect(() => {
    if (!isCustomer) return undefined;
    let cancelled = false;
    accountApi
      .getAccountDashboard()
      .then((d) => {
        if (!cancelled) setPartsCount(d.total_parts);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[AdminLayout] account dashboard fetch failed', err);
        setPartsCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [isCustomer]);

  // Sidebar badge counts. Demo mode = seeded magnitudes; live mode hits
  // /api/dashboard/stats. Import-queue is always 0 in live mode (no
  // backend yet) — badge hides when count is 0. The `cancelled` closure
  // guards against a rapid demoMode toggle stomping demo magnitudes with
  // a late API response.
  useEffect(() => {
    if (isCustomer) return undefined;
    if (demoMode) {
      setPartsCount(DEMO_BADGES.parts);
      setSuppliersCount(DEMO_BADGES.suppliers);
      setManufacturersCount(DEMO_BADGES.manufacturers);
      return undefined;
    }
    let cancelled = false;
    adminApi
      .getStats()
      .then((s) => {
        if (cancelled) return;
        setPartsCount(s.parts_count ?? 0);
        setSuppliersCount(s.suppliers_count ?? 0);
        setManufacturersCount(s.manufacturers_count ?? 0);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn('[AdminLayout] dashboard stats fetch failed', err);
        setPartsCount(0);
        setSuppliersCount(0);
        setManufacturersCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [demoMode, isCustomer]);

  // Refresh unread count when route changes — covers list/detail navigation
  // that flips messages from new → read. Also auto-closes the mobile drawer.
  // On every pathname transition (including initial mount), pull fresh
  // messages from the API so the bell-count stays in sync with the DB even
  // when the admin user is on a non-Messages page.
  useEffect(() => {
    if (isCustomer) {
      // A customer's inbox is a different slice of the same table behind a
      // different route (`messages.user_id` is theirs; NULL is the shared
      // staff inbox), so it never touches messageStore — whose cache backs
      // the staff Messages screen and whose fetch is require_staff.
      let cancelled = false;
      accountApi
        .getAccountMessages()
        .then((rows) => {
          if (!cancelled) setUnread(rows.filter((m) => !m.read).length);
        })
        .catch((err) => {
          if (cancelled) return;
          console.warn('[AdminLayout] account messages fetch failed', err);
          setUnread(0);
        });
      setMenuOpen(false);
      return () => {
        cancelled = true;
      };
    }
    refreshMessages().then(() => {
      setUnread(unreadCount());
    });
    setUnread(unreadCount()); // optimistic read from cache so the badge doesn't flicker
    setMenuOpen(false);
    return undefined;
  }, [location.pathname, isCustomer]);

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

  const customerNav = isCustomer ? customerLinks(isSupplier, isManufacturer) : null;
  const catalogVisible = customerNav ? customerNav.catalog : CATALOG_LINKS;
  const commsVisible = customerNav ? customerNav.comms : COMMS_LINKS;
  const systemVisible = customerNav ? CUSTOMER_SYSTEM_LINKS : SYSTEM_LINKS;

  const initials = (user?.username || 'AD').slice(0, 2).toUpperCase();
  const title = pageTitle(location.pathname);

  function badgeValue(key: BadgeKey | undefined): string | null {
    if (!key) return null;
    if (key === 'parts') return partsCount > 0 ? formatBadgeCount(partsCount) : null;
    if (key === 'suppliers') return suppliersCount > 0 ? String(suppliersCount) : null;
    if (key === 'manufacturers') return manufacturersCount > 0 ? formatBadgeCount(manufacturersCount) : null;
    if (key === 'imports') {
      // No live import-queue API yet; show only in demo mode, hide otherwise.
      return demoMode ? String(DEMO_BADGES.imports) : null;
    }
    return null;
  }

  function renderLink(link: SidebarLink) {
    const showUnreadBadge = link.to === '/admin/messages' && unread > 0;
    const dynamicBadge = badgeValue(link.badgeKey);
    const href = mountPath(link.to, base);
    return (
      <NavLink
        key={link.to}
        to={href}
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
        <Link to={base} className={styles.sideBrand}>
          {/* Was a letter "C" on a green tile, standing in for a logo that did
              not exist. No `title` — "Circuit Center" is spelled out beside it. */}
          <Logo variant="badge" size={30} className={styles.sideBrandMark} />
          <div>
            <div className={styles.sideBrandName}>Circuit Center</div>
            <div className={styles.sideBrandRole}>
              {isCustomer ? 'Account' : isReadOnly ? 'View only' : 'Admin'}
            </div>
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
        {systemVisible.map(renderLink)}

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

            {/* Read-only staff: say so where every Save/Delete would otherwise
                fail with no warning. The server is the enforcement. */}
            {isReadOnly && (
              <span
                className={styles.readOnlyBadge}
                title="This account can see everything and change nothing"
              >
                View only
              </span>
            )}

            {!isCustomer && (
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
            )}

            {/* One soft pill groups everything that is "about you": who else is
                here, the theme toggle, notifications, and your own avatar. */}
            <div className={styles.ctrlPill}>
              {/* The roster ping is require_staff — for a customer it would be
                  a 403 every 15 seconds and never a bubble. */}
              {!isCustomer && <PresenceBubbles selfUsername={user?.username} />}

              <button
                type="button"
                className={`${styles.chip} ${styles.chipTheme}`}
                title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
                onClick={toggleTheme}
              >
                {theme === 'dark' ? (
                  <Sun size={16} strokeWidth={2} />
                ) : (
                  <Moon size={16} strokeWidth={2} />
                )}
              </button>

              <div className={styles.bellWrap}>
                <button
                  type="button"
                  className={`${styles.chip} ${styles.chipBell} ${wiggle ? styles.bellWiggle : ''}`}
                  title="Notifications"
                  aria-label="Notifications"
                  onClick={() => {
                    if (isCustomer) {
                      // BellDropdown renders the STAFF Message shape — a
                      // sender to reply to, a designator, a workflow status —
                      // none of which an account inbox row has. The badge is
                      // the notification; the inbox is one click away.
                      navigate(mountPath('/admin/messages', base));
                      return;
                    }
                    setBellOpen((b) => !b);
                  }}
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
                      navigate(mountPath('/admin/messages', base));
                    }}
                    onOpen={(id) => {
                      setBellOpen(false);
                      navigate(mountPath(`/admin/messages/${id}`, base));
                    }}
                  />
                )}
              </div>

              {/* Was the sidebar's .sideProfile block — the identity now anchors
                  the right end of the pill. No click action yet. */}
              <span
                className={`${styles.chip} ${styles.chipAvatar}`}
                title={`${user?.username || 'Admin'} · ${user?.role || 'admin'}`}
              >
                {initials}
              </span>
            </div>

            {/* POST /api/parts/ is require_staff, so for a customer this is a
                button that cannot succeed. Their catalog changes through the
                feed and through us. */}
            {!isCustomer && (
              <Link to={mountPath('/admin/parts/new', base)} className={`${styles.btn} ${styles.btnPrimary}`}>
                <Plus size={15} strokeWidth={2} />
                <span className={styles.btnLabel}>New Part</span>
              </Link>
            )}
          </div>
        </header>

        <div
          key={
            canonicalPath(location.pathname) === '/admin' ||
            canonicalPath(location.pathname).startsWith('/admin/dashboard')
              ? theme
              : 'admin'
          }
          className={styles.content}
        >
          {children}
        </div>
      </div>

      <SignOutModal
        open={signOutOpen}
        onConfirm={() => {
          setSignOutOpen(false);
          logout();
        }}
        onCancel={() => setSignOutOpen(false)}
      />

      <Wizard />
    </div>
  );
}
