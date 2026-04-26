import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Search, Pencil, X } from 'lucide-react';
import { adminApi } from '../../services/adminApi';
import type { AdminSponsor, AdminSupplier, AdminCategory, SponsorTier } from '../../types/admin';
import styles from './SponsorsPage.module.scss';

// Phase A6 — list page ported from 2026-04-25 Claude Design bundle
// (project/ui_kits/admin/pages.jsx → SponsorsListPage).
//
// No backend admin sponsor CRUD exists yet, so the list is sourced from
// localStorage-persisted seed data; adminApi.getStats() still drives the
// upstream "Active sponsorships" count when available.

const TIERS: SponsorTier[] = ['Featured', 'Platinum', 'Gold', 'Silver'];

// LocalStorage key for the demo sponsor store. SponsorFormPage writes the
// same key so list + form stay in sync without a real backend.
const STORE_KEY = 'circuits.admin.sponsors';

function loadStore(): AdminSponsor[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as AdminSponsor[];
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {
    /* fall through to seed */
  }
  return SEED_SPONSORS;
}

const SEED_SPONSORS: AdminSponsor[] = [
  {
    id: 'spn-honeywell-sensors',
    supplier_id: 'seed-supplier-honeywell',
    supplier_name: 'Honeywell Sensing',
    tier: 'Featured',
    category_id: 'cat-sensors',
    category_name: 'Sensors & Transducers',
    keyword: null,
    start_date: '2026-01-01',
    end_date: '2026-12-31',
    amount: 7000,
    status: 'Active',
  },
  {
    id: 'spn-ti-keyword-vreg',
    supplier_id: 'seed-supplier-ti',
    supplier_name: 'Texas Instruments',
    tier: 'Gold',
    category_id: null,
    category_name: null,
    keyword: 'voltage regulator',
    start_date: '2026-03-01',
    end_date: '2026-09-30',
    amount: 1500,
    status: 'Active',
  },
  {
    id: 'spn-arrow-pmic',
    supplier_id: 'seed-supplier-arrow',
    supplier_name: 'Arrow Electronics',
    tier: 'Platinum',
    category_id: 'cat-pmic',
    category_name: 'Power Management ICs',
    keyword: null,
    start_date: '2026-02-01',
    end_date: '2027-01-31',
    amount: 4500,
    status: 'Active',
  },
  {
    id: 'spn-mouser-keyword-stm32',
    supplier_id: 'seed-supplier-mouser',
    supplier_name: 'Mouser Electronics',
    tier: 'Silver',
    category_id: null,
    category_name: null,
    keyword: 'stm32',
    start_date: '2025-11-01',
    end_date: '2026-05-01',
    amount: 800,
    status: 'Paused',
  },
];

type TierFilter = 'All' | SponsorTier;

const TIER_FILTERS: TierFilter[] = ['All', ...TIERS];

function tierClass(tier: SponsorTier): string {
  switch (tier) {
    case 'Featured':
      return styles.tierFeatured;
    case 'Platinum':
      return styles.tierPlatinum;
    case 'Gold':
      return styles.tierGold;
    case 'Silver':
      return styles.tierSilver;
  }
}

function statusClass(status: AdminSponsor['status']): string {
  switch (status) {
    case 'Active':
      return styles.statusActive;
    case 'Paused':
      return styles.statusPaused;
    case 'Expired':
      return styles.statusExpired;
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return iso;
}

function formatAmount(n: number): string {
  return `$${n.toLocaleString()}`;
}

export default function SponsorsPage() {
  const navigate = useNavigate();
  const [sponsors, setSponsors] = useState<AdminSponsor[]>(() => loadStore());
  const [tierFilter, setTierFilter] = useState<TierFilter>('All');
  const [search, setSearch] = useState('');
  const [suppliers, setSuppliers] = useState<AdminSupplier[]>([]);
  const [categories, setCategories] = useState<AdminCategory[]>([]);

  // Refresh from localStorage when navigating back from the form page.
  useEffect(() => {
    setSponsors(loadStore());
  }, []);

  // Pull live suppliers/categories so the in-memory sponsor records can be
  // re-keyed against current DB ids without losing the seed fallback.
  useEffect(() => {
    adminApi
      .getSuppliers()
      .then(setSuppliers)
      .catch(() => {});
    adminApi
      .getCategories()
      .then(setCategories)
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sponsors.filter((s) => {
      if (tierFilter !== 'All' && s.tier !== tierFilter) return false;
      if (!q) return true;
      const haystack = [
        s.supplier_name,
        s.category_name ?? '',
        s.keyword ?? '',
        s.tier,
        s.status,
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [sponsors, tierFilter, search]);

  const tierCounts = useMemo(() => {
    const map: Record<TierFilter, number> = {
      All: sponsors.length,
      Featured: 0,
      Platinum: 0,
      Gold: 0,
      Silver: 0,
    };
    for (const s of sponsors) map[s.tier]++;
    return map;
  }, [sponsors]);

  // Hydrate supplier/category names from live API data when ids match.
  const enriched = useMemo(() => {
    if (suppliers.length === 0 && categories.length === 0) return filtered;
    const supMap = new Map(suppliers.map((s) => [s.id, s.name]));
    const catMap = new Map<string, string>();
    for (const c of categories) {
      catMap.set(c.id, c.name);
      for (const child of c.children ?? []) catMap.set(child.id, child.name);
    }
    return filtered.map((s) => ({
      ...s,
      supplier_name: supMap.get(s.supplier_id) ?? s.supplier_name,
      category_name: s.category_id ? catMap.get(s.category_id) ?? s.category_name : null,
    }));
  }, [filtered, suppliers, categories]);

  return (
    <div className={styles.page}>
      <header className={styles.pageHead}>
        <div className={styles.pageHeadLeft}>
          <h1 className={styles.title}>Sponsors</h1>
          <p className={styles.subtitle}>
            Paid placements: category banners, keyword takeovers, featured supplier slots.
          </p>
        </div>
        <div className={styles.pageHeadActions}>
          <Link to="/admin/sponsors/new" className={`${styles.btn} ${styles.btnPrimary}`}>
            <Plus size={15} strokeWidth={2} />
            New Sponsor
          </Link>
        </div>
      </header>

      <div className={styles.panel}>
        <div className={styles.toolbar}>
          {TIER_FILTERS.map((t) => (
            <button
              key={t}
              type="button"
              className={`${styles.filterChip} ${tierFilter === t ? styles.filterChipActive : ''}`}
              onClick={() => setTierFilter(t)}
            >
              {t}
              <span className={styles.chipCount}>{tierCounts[t]}</span>
            </button>
          ))}
          <div className={styles.toolbarSpacer} />
          <div className={styles.inlineSearch}>
            <Search size={14} strokeWidth={2} />
            <input
              type="text"
              placeholder="Search sponsors, keywords, categories..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className={styles.searchClear}
                onClick={() => setSearch('')}
                aria-label="Clear search"
              >
                <X size={12} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>

        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Tier</th>
                <th>Placement</th>
                <th>Window</th>
                <th>Monthly</th>
                <th>Status</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {enriched.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.supplier_name}</strong>
                  </td>
                  <td>
                    <span className={`${styles.tierBadge} ${tierClass(s.tier)}`}>{s.tier}</span>
                  </td>
                  <td>
                    {s.category_id ? (
                      <span className={styles.placementCategory}>{s.category_name ?? s.category_id}</span>
                    ) : (
                      <span className={styles.placementKeyword}>
                        <span className={styles.placementLabel}>keyword:</span>
                        <span className={styles.mono}>{s.keyword}</span>
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={styles.windowText}>
                      {formatDate(s.start_date)} <span className={styles.windowArrow}>&rarr;</span>{' '}
                      {formatDate(s.end_date)}
                    </span>
                  </td>
                  <td>
                    <span className={styles.amountText}>{formatAmount(s.amount)}</span>
                  </td>
                  <td>
                    <span className={`${styles.statusBadge} ${statusClass(s.status)}`}>{s.status}</span>
                  </td>
                  <td className={styles.rowActionsCell}>
                    <button
                      type="button"
                      className={styles.rowAction}
                      onClick={() => navigate(`/admin/sponsors/${s.id}/edit`)}
                      aria-label={`Edit sponsor ${s.supplier_name}`}
                    >
                      <Pencil size={14} strokeWidth={2} />
                    </button>
                  </td>
                </tr>
              ))}
              {enriched.length === 0 && (
                <tr>
                  <td colSpan={7} className={styles.emptyRow}>
                    {sponsors.length === 0
                      ? 'No active sponsorships. Click + New Sponsor to add one.'
                      : 'No sponsors match the current filters.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
