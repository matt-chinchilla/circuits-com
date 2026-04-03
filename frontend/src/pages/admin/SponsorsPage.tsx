import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import StatCard from '../../components/admin/StatCard';
import DataTable from '../../components/admin/DataTable';
import { useDemo } from '../../contexts/DemoContext';
import { adminApi } from '../../services/adminApi';
import type { DashboardStats } from '../../types/admin';
import styles from './SponsorsPage.module.scss';

interface SponsorRow {
  id: string;
  supplier_name: string;
  type: string;
  target: string;
  tier: string;
  date_range: string;
  status: string;
  supplier_id: string;
  [key: string]: unknown;
}

// Fallback sponsor data derived from known seed data
const SEED_SPONSORS: SponsorRow[] = [
  {
    id: 'sponsor-1',
    supplier_name: 'Honeywell Aerospace',
    type: 'Category',
    target: 'Sensors & Transducers',
    tier: 'gold',
    date_range: 'Jan 2026 - Dec 2026',
    status: 'active',
    supplier_id: 'seed-supplier-honeywell',
  },
  {
    id: 'sponsor-2',
    supplier_name: 'Texas Instruments',
    type: 'Keyword',
    target: 'voltage regulator',
    tier: 'silver',
    date_range: 'Mar 2026 - Sep 2026',
    status: 'active',
    supplier_id: 'seed-supplier-ti',
  },
];

function tierBadge(tier: string, tierStyles: typeof styles) {
  let cls = tierStyles.tierGold;
  if (tier === 'silver') cls = tierStyles.tierSilver;
  if (tier === 'bronze') cls = tierStyles.tierBronze;
  return <span className={`${tierStyles.tierBadge} ${cls}`}>{tier}</span>;
}

function statusBadge(status: string, statusStyles: typeof styles) {
  const cls = status === 'active' ? statusStyles.statusActive : statusStyles.statusExpired;
  return <span className={`${statusStyles.statusBadge} ${cls}`}>{status}</span>;
}

const COLUMNS = [
  { key: 'supplier_name', label: 'Supplier', sortable: true },
  {
    key: 'type',
    label: 'Type',
    render: (row: SponsorRow) => {
      const cls = row.type === 'Category' ? styles.typeCategory : styles.typeKeyword;
      return <span className={`${styles.typeBadge} ${cls}`}>{row.type}</span>;
    },
  },
  { key: 'target', label: 'Target', sortable: true },
  {
    key: 'tier',
    label: 'Tier',
    sortable: true,
    render: (row: SponsorRow) => tierBadge(row.tier, styles),
  },
  { key: 'date_range', label: 'Date Range' },
  {
    key: 'status',
    label: 'Status',
    render: (row: SponsorRow) => statusBadge(row.status, styles),
  },
];

export default function SponsorsPage() {
  const navigate = useNavigate();
  const { demoMode } = useDemo();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [sponsors, setSponsors] = useState<SponsorRow[]>([]);

  useEffect(() => {
    if (!demoMode) {
      setStats(null);
      setSponsors([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    adminApi
      .getStats()
      .then((s) => {
        setStats(s);
        // Use seed data as the detailed sponsor list
        setSponsors(SEED_SPONSORS);
      })
      .catch(() => {
        // Graceful fallback: show seed sponsors even if API is down
        setSponsors(SEED_SPONSORS);
      })
      .finally(() => setLoading(false));
  }, [demoMode]);

  const sponsorCount = demoMode ? (stats?.sponsors_count ?? sponsors.length) : 0;
  const goldCount = sponsors.filter((s) => s.tier === 'gold').length;
  const silverCount = sponsors.filter((s) => s.tier === 'silver').length;

  // Estimate sponsor revenue as portion of total
  const sponsorRevenue = demoMode ? (stats?.revenue_total ?? 0) * 0.35 : 0;

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Sponsors' }]} />

      <div className={styles.header}>
        <h1 className={styles.title}>Sponsors</h1>
        <p className={styles.subtitle}>
          Manage sponsored placements across categories and keywords.
        </p>
      </div>

      <div className={styles.statsGrid}>
        <StatCard label="Total Sponsors" value={sponsorCount} icon={'\u2B50'} />
        <StatCard label="Gold Tier" value={goldCount} icon={'\uD83E\uDD47'} />
        <StatCard label="Silver Tier" value={silverCount} icon={'\uD83E\uDD48'} />
        <StatCard
          label="Sponsor Revenue"
          value={`$${sponsorRevenue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          icon={'\uD83D\uDCB0'}
        />
      </div>

      <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Active Sponsorships</h2>
      </div>

      {!demoMode ? (
        <div className={styles.emptyState}>
          <p className={styles.emptyTitle}>No real data yet</p>
          <p className={styles.emptyDescription}>
            Enable demo mode to see sample sponsor data.
          </p>
        </div>
      ) : (
        <DataTable
          columns={COLUMNS}
          data={sponsors}
          loading={loading}
          emptyMessage="No sponsors configured."
          onRowClick={(row) => navigate(`/admin/suppliers/${row.supplier_id}`)}
        />
      )}

      <div className={styles.infoCard}>
        <h3 className={styles.infoTitle}>About Sponsorships</h3>
        <p className={styles.infoText}>
          Sponsors are linked to either a <strong>category</strong> (displayed on category pages) or a <strong>keyword</strong> (displayed in search results).
          Each sponsor has a tier (Gold, Silver, Bronze) that determines placement priority and visual prominence.
        </p>
        <p className={styles.infoText}>
          Sponsor records are managed through the SQLAdmin panel at <code>/admin</code>. The XOR constraint ensures each
          sponsor targets exactly one category or keyword, never both.
        </p>
      </div>
    </div>
  );
}
