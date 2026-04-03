import { useState, useEffect } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar,
  PieChart, Pie, Cell,
} from 'recharts';
import Breadcrumbs from '../../components/admin/Breadcrumbs';
import { adminApi } from '../../services/adminApi';
import type { RevenueDataPoint, PopularData } from '../../types/admin';
import styles from './ReportsPage.module.scss';

const PIE_COLORS = ['#0a4a2e', '#3498db', '#27ae60', '#f39c12', '#e74c3c'];

export default function ReportsPage() {
  const [revenue, setRevenue] = useState<RevenueDataPoint[]>([]);
  const [popular, setPopular] = useState<PopularData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    Promise.all([adminApi.getRevenue(), adminApi.getPopular()])
      .then(([r, p]) => {
        setRevenue(r);
        setPopular(p);
      })
      .catch(() => setError('Failed to load report data.'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className={styles.loading}>Loading reports...</div>;
  }

  if (error) {
    return (
      <div className={styles.page}>
        <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Reports' }]} />
        <div className={styles.error}>{error}</div>
      </div>
    );
  }

  // Build pie data: sum revenue by type across all months
  const typeSums: Record<string, number> = { sponsorship: 0, listing_fee: 0, featured: 0 };
  for (const r of revenue) {
    typeSums.sponsorship += r.sponsorship;
    typeSums.listing_fee += r.listing_fee;
    typeSums.featured += r.featured;
  }
  const pieData = Object.entries(typeSums)
    .filter(([, v]) => v > 0)
    .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }));

  return (
    <div className={styles.page}>
      <Breadcrumbs items={[{ label: 'Dashboard', href: '/admin' }, { label: 'Reports' }]} />

      <h1 className={styles.title}>Reports</h1>
      <p className={styles.subtitle}>Revenue and parts analytics for the past 12 months.</p>

      <div className={styles.chartsGrid}>
        {/* Revenue over time */}
        <div className={`${styles.chartCard} ${styles.chartCardFull}`}>
          <h2 className={styles.chartTitle}>Revenue Over Time</h2>
          <ResponsiveContainer width="100%" height={350}>
            <LineChart data={revenue}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="month" tick={{ fontSize: 14 }} />
              <YAxis tick={{ fontSize: 14 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="total" stroke="#0a4a2e" strokeWidth={2} name="Total" />
              <Line type="monotone" dataKey="sponsorship" stroke="#3498db" strokeWidth={2} name="Sponsorship" />
              <Line type="monotone" dataKey="listing_fee" stroke="#27ae60" strokeWidth={2} name="Listing Fee" />
              <Line type="monotone" dataKey="featured" stroke="#f39c12" strokeWidth={2} name="Featured" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Revenue by type pie */}
        <div className={styles.chartCard}>
          <h2 className={styles.chartTitle}>Revenue by Type</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={(props) => `${props.name ?? ''} (${((props.percent ?? 0) * 100).toFixed(0)}%)`}
              >
                {pieData.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Parts by category bar */}
        <div className={styles.chartCard}>
          <h2 className={styles.chartTitle}>Parts by Category</h2>
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

        {/* Top suppliers bar */}
        <div className={styles.chartCard}>
          <h2 className={styles.chartTitle}>Top Suppliers by Listings</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={popular?.top_suppliers ?? []}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" tick={{ fontSize: 12 }} angle={-30} textAnchor="end" height={80} />
              <YAxis tick={{ fontSize: 14 }} />
              <Tooltip />
              <Bar dataKey="listings_count" fill="#3498db" name="Listings" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
