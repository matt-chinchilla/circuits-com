import { useState, useEffect, useMemo } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, Search, Pencil, X } from 'lucide-react';
import { loadSponsors } from '@admin/services/sponsorStore';
import Icon from '@shared/components/Icon';
import type { AdminSponsor, SponsorTier, SponsorStatus } from '@admin/types/admin';
import styles from './SponsorsPage.module.scss';

// Phase A6 — list page ported from 2026-04-25 Claude Design bundle
// (project/ui_kits/admin/pages.jsx → SponsorsListPage).
//
// Persistence routed through @admin/services/sponsorStore, which is now
// API-backed (`/api/admin/sponsors/`). Mirrors the Messages list: fetch on
// mount via useEffect + state, with a cancel flag so a late response can't
// stomp an unmounted component. The backend returns supplier_name /
// category_name / category_icon directly, so no client-side id→name mapping
// is needed anymore.

const TIERS: SponsorTier[] = ['Platinum', 'Gold', 'Silver'];

type TierFilter = 'All' | SponsorTier;

const TIER_FILTERS: TierFilter[] = ['All', ...TIERS];

function tierClass(tier: SponsorTier): string {
  switch (tier) {
    case 'Platinum':
      return styles.tierPlatinum;
    case 'Gold':
      return styles.tierGold;
    case 'Silver':
      return styles.tierSilver;
  }
}

function statusClass(status: SponsorStatus | null): string {
  switch (status) {
    case 'Active':
      return styles.statusActive;
    case 'Paused':
      return styles.statusPaused;
    case 'Expired':
      return styles.statusExpired;
    default:
      return '';
  }
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return iso;
}

function formatAmount(n: number | null): string {
  if (n == null) return '—';
  return `$${n.toLocaleString()}`;
}

export default function SponsorsPage() {
  const navigate = useNavigate();
  const [sponsors, setSponsors] = useState<AdminSponsor[]>([]);
  const [loading, setLoading] = useState(true);
  const [tierFilter, setTierFilter] = useState<TierFilter>('All');
  const [search, setSearch] = useState('');

  // Fetch sponsors from the API on mount. Cancel flag guards against a late
  // response resolving after unmount (CLAUDE.md state-dep-effect pattern).
  useEffect(() => {
    let cancelled = false;
    loadSponsors()
      .then((rows) => {
        if (cancelled) return;
        setSponsors(rows);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[SponsorsPage] load failed', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
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
      Platinum: 0,
      Gold: 0,
      Silver: 0,
    };
    // Guard against legacy rows still carrying a dropped tier (e.g. pre-013
    // 'Featured') — those land in `map[s.tier]` as undefined and would NaN the
    // running count, so skip any tier outside the current union.
    for (const s of sponsors) {
      if (s.tier in map) map[s.tier]++;
    }
    return map;
  }, [sponsors]);

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
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td>
                    <strong>{s.supplier_name}</strong>
                  </td>
                  <td>
                    <span className={`${styles.tierBadge} ${tierClass(s.tier)}`}>{s.tier}</span>
                  </td>
                  <td>
                    {s.category_id ? (
                      <span className={styles.placementCategory}>
                        <Icon name={s.category_icon} />
                        <span>{s.category_name ?? s.category_id}</span>
                      </span>
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
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={7} className={styles.emptyRow}>
                    {loading
                      ? 'Loading sponsors…'
                      : sponsors.length === 0
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
