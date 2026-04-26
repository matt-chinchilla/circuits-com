import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Search, Upload } from 'lucide-react';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import type { AdminSupplier } from '../../types/admin';
import styles from './SuppliersPage.module.scss';

// Bundle parity: each supplier card renders a tier pill. The real
// AdminSupplier type doesn't yet carry a tier column, so we derive a
// stable demo-friendly tier from parts_count buckets. When an explicit
// tier field is added later, swap this for `s.tier`.
type Tier = 'featured' | 'platinum' | 'gold' | 'silver';

const TIERS: { key: 'all' | Tier; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'featured', label: 'Featured' },
  { key: 'platinum', label: 'Platinum' },
  { key: 'gold', label: 'Gold' },
  { key: 'silver', label: 'Silver' },
];

const TIER_CLASS: Record<Tier, string> = {
  featured: styles.tierFeatured,
  platinum: styles.tierPlatinum,
  gold: styles.tierGold,
  silver: styles.tierSilver,
};

function deriveTier(s: AdminSupplier): Tier {
  const n = s.parts_count ?? 0;
  if (n >= 200) return 'featured';
  if (n >= 100) return 'platinum';
  if (n >= 25) return 'gold';
  return 'silver';
}

function lettermark(name: string): string {
  return (name?.trim()?.[0] ?? '?').toUpperCase();
}

export default function SuppliersPage() {
  const navigate = useNavigate();
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | Tier>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    adminApi
      .getSuppliers()
      .then(setSuppliers)
      .catch(() => setError('Failed to load suppliers.'))
      .finally(() => setLoading(false));
  }, []);

  const annotated = useMemo(
    () => suppliers.map((s) => ({ supplier: s, tier: deriveTier(s) })),
    [suppliers]
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return annotated.filter(({ supplier, tier }) => {
      if (filter !== 'all' && tier !== filter) return false;
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
            {suppliers.length} active distributors &middot; all visible regardless of part count
          </p>
        </div>
        <div className={styles.pageHeadActions}>
          <Link to="/admin/import" className={`${styles.btn} ${styles.btnGhost}`}>
            <Upload size={16} strokeWidth={2} />
            Import CSV
          </Link>
          <Link to="/admin/suppliers/new" className={`${styles.btn} ${styles.btnPrimary}`}>
            <Plus size={16} strokeWidth={2} />
            Add Supplier
          </Link>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          {TIERS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`${styles.filterChip} ${filter === t.key ? styles.filterChipActive : ''}`}
              onClick={() => setFilter(t.key)}
            >
              {t.label}
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
            filtered.map(({ supplier, tier }) => (
              <article
                key={supplier.id}
                className={styles.supCard}
                onClick={() => navigate(`/admin/suppliers/${supplier.id}`)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    navigate(`/admin/suppliers/${supplier.id}`);
                  }
                }}
              >
                <div className={styles.supHead}>
                  <div className={styles.supLogo}>{lettermark(supplier.name)}</div>
                  <div className={styles.supHeadBody}>
                    <h3 className={styles.supName}>{supplier.name}</h3>
                    <div className={styles.supTierRow}>
                      <span className={`${styles.supTier} ${TIER_CLASS[tier]}`}>
                        {tier.charAt(0).toUpperCase() + tier.slice(1)}
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
            ))}
        </div>
      </div>
    </div>
  );
}
