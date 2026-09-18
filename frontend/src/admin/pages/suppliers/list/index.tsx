import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { Plus, Search, Upload } from 'lucide-react';
import Breadcrumbs from '@admin/components/Breadcrumbs';
import { useAuth } from '@admin/contexts/AuthContext';
import { adminApi } from '@admin/services/adminApi';
import type { AdminSupplier, AdminSponsor, SponsorTier } from '@admin/types/admin';
import { lettermark } from '@shared/utils/lettermark';
import { safeImageUrl } from '@shared/utils/url';
import {
  buildSponsorshipBySupplier,
  supplierSponsorship,
  SPONSORSHIP_FILTERS,
  type SupplierSponsorship,
  type SponsorshipFilter,
} from '../sponsorship';
import AccountSuppliersList from './AccountSuppliersList';
import styles from './SuppliersPage.module.scss';

const SPONSORSHIP_CLASS: Record<SupplierSponsorship, string> = {
  Platinum: styles.tierPlatinum,
  Gold: styles.tierGold,
  Silver: styles.tierSilver,
  None: styles.tierNone,
};

/**
 * One URL, two questions.
 *
 * Staff get every distributor in the catalog; a customer gets the distributors
 * selling THEIR products (GET /api/account/suppliers, scoped server-side). Two
 * components rather than branches inside one, so the staff render below is the
 * code it always was and neither branch's hooks are conditional.
 */
export default function SuppliersPage() {
  const { isCustomer } = useAuth();
  return isCustomer ? <AccountSuppliersList /> : <StaffSuppliersPage />;
}

function StaffSuppliersPage() {
  // Canonical /admin paths, rewritten onto whichever mount is rendering (D16).
  const consolePath = useConsolePath();
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [sponsorMap, setSponsorMap] = useState<Map<string, SponsorTier>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<SponsorshipFilter>('All');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      adminApi.getSuppliers(),
      // Sponsorship only enriches the badge; if it fails the suppliers still
      // load (badges fall back to None) rather than blanking the whole page.
      adminApi.getSponsors().catch((e) => {
        console.warn('[SuppliersPage] getSponsors failed; badges default to None', e);
        return [] as AdminSponsor[];
      }),
    ])
      .then(([sups, spons]) => {
        if (cancelled) return;
        setSuppliers(sups);
        setSponsorMap(buildSponsorshipBySupplier(spons));
      })
      .catch(() => {
        if (!cancelled) setError('Failed to load suppliers.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const annotated = useMemo(
    () =>
      suppliers.map((s) => ({
        supplier: s,
        sponsorship: supplierSponsorship(s.id, sponsorMap),
      })),
    [suppliers, sponsorMap]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return annotated.filter(({ supplier, sponsorship }) => {
      if (filter !== 'All' && sponsorship !== filter) return false;
      if (!q) return true;
      const haystacks = [
        supplier.name,
        supplier.email ?? '',
        supplier.website ?? '',
        supplier.contact_name ?? '',
      ];
      return haystacks.some((h) => h.toLowerCase().includes(q));
    });
  }, [annotated, filter, query]);

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Suppliers' }]} />

      <div className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Suppliers</h1>
          <p className={styles.subtitle}>
            {suppliers.length} active distributors &middot; badge shows current sponsorship
          </p>
        </div>
        <div className={styles.pageHeadActions}>
          <Link to={consolePath('/admin/import')} className={`${styles.btn} ${styles.btnGhost}`}>
            <Upload size={16} strokeWidth={2} />
            Import CSV
          </Link>
          <Link
            to={consolePath('/admin/suppliers/new')}
            data-tour="add-supplier"
            className={`${styles.btn} ${styles.btnPrimary}`}
          >
            <Plus size={16} strokeWidth={2} />
            Add Supplier
          </Link>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          {SPONSORSHIP_FILTERS.map((t) => (
            <button
              key={t}
              type="button"
              className={`${styles.filterChip} ${filter === t ? styles.filterChipActive : ''}`}
              onClick={() => setFilter(t)}
            >
              {t}
            </button>
          ))}
          <div className={styles.toolbarSpacer} />
          <div className={styles.inlineSearch}>
            <Search size={14} strokeWidth={2} />
            <input
              type="text"
              placeholder="Search suppliers&hellip;"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <span className={styles.toolbarCount}>
            {filtered.length} of {suppliers.length}
          </span>
        </div>

        <div className={styles.supGrid}>
          {loading && <div className={styles.empty}>Loading suppliers&hellip;</div>}
          {!loading && error && <div className={styles.error}>{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className={styles.empty}>No suppliers match this filter.</div>
          )}
          {!loading &&
            !error &&
            filtered.map(({ supplier, sponsorship }) => {
              const logoSrc = safeImageUrl(supplier.logo_url);
              return <article
                key={supplier.id}
                data-tour="supplier-card"
                className={styles.supCard}
                onClick={() => navigate(consolePath(`/admin/suppliers/${supplier.id}`))}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(consolePath(`/admin/suppliers/${supplier.id}`));
                  }
                }}
              >
                <div className={styles.supHead}>
                  <div className={styles.supLogo}>
                    {logoSrc ? (
                      <img className={styles.avatarImg} src={logoSrc} alt="" />
                    ) : (
                      <span>{lettermark(supplier.name)}</span>
                    )}
                  </div>
                  <div className={styles.supHeadBody}>
                    <h3 className={styles.supName}>{supplier.name}</h3>
                    <div className={styles.supTierRow}>
                      <span className={`${styles.supTier} ${SPONSORSHIP_CLASS[sponsorship]}`}>
                        {sponsorship}
                      </span>
                    </div>
                  </div>
                </div>
                <p className={styles.supDesc}>
                  {supplier.description?.trim() || 'No description provided.'}
                </p>
                <div className={styles.supMeta}>
                  <span className={styles.mono}>
                    {(supplier.parts_count ?? 0).toLocaleString()} parts
                  </span>
                  <span>&middot;</span>
                  <span>
                    {supplier.categories && supplier.categories.length > 0
                      ? `${supplier.categories.length} categories`
                      : 'No categories'}
                  </span>
                </div>
              </article>
            })}
        </div>
      </div>
    </div>
  );
}
