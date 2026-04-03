import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from 'recharts';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import StatCard from '../../components/admin/StatCard';
import { adminApi } from '../../services/adminApi';
import type { DashboardStats, ActivityItem, RevenueDataPoint, PopularData } from '../../types/admin';
import styles from './DashboardPage.module.scss';

function activityIcon(type: string): string {
  if (type === 'part_added') return '\uD83E\uDDF0';
  if (type === 'revenue') return '\uD83D\uDCB0';
  return '\uD83D\uDD14';
}

function formatTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [revenue, setRevenue] = useState<RevenueDataPoint[]>([]);
  const [popular, setPopular] = useState<PopularData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [s, a, r, p] = await Promise.all([
          adminApi.getStats(),
          adminApi.getActivity(),
          adminApi.getRevenue(),
          adminApi.getPopular(),
        ]);
        setStats(s);
        setActivity(a);
        setRevenue(r);
        setPopular(p);
      } catch {
        // Data will remain in initial state
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return <div className={styles.loading}>Loading dashboard...</div>;
  }

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard' }]} />

      <div className={styles.header}>
        <h1 className={styles.title}>Dashboard</h1>
        <p className={styles.subtitle}>Overview of your electronic components directory</p>
      </div>

      <div className={styles.statsGrid}>
        <StatCard
          label="Total Parts"
          value={stats?.parts_count ?? 0}
          icon={'\uD83E\uDDF0'}
        />
        <StatCard
          label="Suppliers"
          value={stats?.suppliers_count ?? 0}
          icon={'\uD83C\uDFED'}
        />
        <StatCard
          label="Revenue"
          value={`$${(stats?.revenue_total ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`}
          icon={'\uD83D\uDCB0'}
        />
        <StatCard
          label="Active Sponsors"
          value={stats?.sponsors_count ?? 0}
          icon={'\u2B50'}
        />
      </div>

      <div className={styles.actions}>
        <Link to="/admin/suppliers/new" className={`${styles.actionBtn} ${styles.actionPrimary}`}>
          + Add Supplier
        </Link>
        <Link to="/admin/parts/new" className={`${styles.actionBtn} ${styles.actionSecondary}`}>
          + Add Part
        </Link>
        <Link to="/admin/import" className={`${styles.actionBtn} ${styles.actionTertiary}`}>
          Import CSV
        </Link>
      </div>

      <div className={styles.chartsRow}>
        <div className={styles.chartCard}>
          <h2 className={styles.chartTitle}>Monthly Revenue</h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={revenue}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fontSize: 14 }} />
              <YAxis tick={{ fontSize: 14 }} />
              <Tooltip />
              <Line type="monotone" dataKey="total" stroke="#0a4a2e" strokeWidth={2} name="Total" />
              <Line type="monotone" dataKey="sponsorship" stroke="#3498db" strokeWidth={2} name="Sponsorship" />
              <Line type="monotone" dataKey="listing_fee" stroke="#27ae60" strokeWidth={2} name="Listing Fee" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className={styles.chartCard}>
          <h2 className={styles.chartTitle}>Top Categories</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={popular?.top_categories ?? []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} angle={-30} textAnchor="end" height={80} />
              <YAxis tick={{ fontSize: 14 }} />
              <Tooltip />
              <Bar dataKey="parts_count" fill="#0a4a2e" name="Parts" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className={styles.activityCard}>
        <h2 className={styles.activityTitle}>Recent Activity</h2>
        {activity.length === 0 ? (
          <p className={styles.emptyActivity}>No recent activity.</p>
        ) : (
          <ul className={styles.activityList}>
            {activity.map((item, i) => (
              <li key={i} className={styles.activityItem}>
                <span className={styles.activityIcon}>{activityIcon(item.type)}</span>
                <div className={styles.activityContent}>
                  <p className={styles.activityDesc}>{item.description}</p>
                  <span className={styles.activityTime}>{formatTime(item.created_at)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
