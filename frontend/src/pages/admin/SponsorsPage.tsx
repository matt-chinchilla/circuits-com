import { useState, useEffect } from 'react';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import DataTable from '../../components/admin/DataTable';
import { adminApi } from '../../services/adminApi';
import type { DashboardStats } from '../../types/admin';
import styles from './SponsorsPage.module.scss';

interface SponsorRow {
  id: string;
  info: string;
  tier: string;
  type: string;
  [key: string]: unknown;
}

const COLUMNS = [
  { key: 'info', label: 'Sponsor Info', sortable: true },
  {
    key: 'type',
    label: 'Type',
    render: (row: SponsorRow) => {
      const cls = row.type === 'Category' ? styles.typeCategory : styles.typeKeyword;
      return <span className={`${styles.typeBadge} ${cls}`}>{row.type as string}</span>;
    },
  },
  {
    key: 'tier',
    label: 'Tier',
    sortable: true,
    render: (row: SponsorRow) => {
      let cls = styles.tierGold;
      if (row.tier === 'silver') cls = styles.tierSilver;
      if (row.tier === 'bronze') cls = styles.tierBronze;
      return <span className={`${styles.tierBadge} ${cls}`}>{row.tier as string}</span>;
    },
  },
];

export default function SponsorsPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi
      .getStats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Since there is no sponsors list endpoint, show a summary view
  // with the count from dashboard stats and direction to the SQLAdmin panel
  const sponsorCount = stats?.sponsors_count ?? 0;

  // Create placeholder rows showing the summary
  const rows: SponsorRow[] = sponsorCount > 0
    ? [{ id: 'summary', info: `${sponsorCount} active sponsor(s)`, tier: 'gold', type: 'Category' }]
    : [];

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Sponsors' }]} />

      <h1 className={styles.title}>Sponsors</h1>
      <p className={styles.subtitle}>
        View and manage sponsored placements. There are currently {sponsorCount} active sponsor(s).
      </p>
      <p className={styles.subtitle}>
        Sponsors are managed in the <a href="/admin" style={{ color: '#3498db' }}>SQLAdmin panel</a> at /admin.
        Each sponsor is linked to either a category or a keyword.
      </p>

      <DataTable
        columns={COLUMNS}
        data={rows}
        loading={loading}
        emptyMessage="No sponsors configured. Add sponsors via the SQLAdmin panel."
      />
    </div>
  );
}
