// QuickActions — the four most common admin entry points, one click from the
// dashboard head.

import { Link } from 'react-router-dom';
import { Plus, Upload } from 'lucide-react';
import styles from '../DashboardPage.module.scss';

const ACTIONS = [
  { to: '/admin/parts/new', label: 'Add Part', icon: 'plus' as const },
  { to: '/admin/suppliers/new', label: 'Add Supplier', icon: 'plus' as const },
  { to: '/admin/sponsors/new', label: 'New Sponsor', icon: 'plus' as const },
  { to: '/admin/expenses/new', label: 'Log Expense', icon: 'plus' as const },
  { to: '/admin/import', label: 'Import CSV', icon: 'upload' as const },
];

export default function QuickActions() {
  return (
    <div className={styles.qaBar}>
      <span className={styles.qaTitle}>Quick actions</span>
      {ACTIONS.map((a) => (
        <Link key={a.to} to={a.to} className={styles.qaBtn}>
          {a.icon === 'plus' ? (
            <Plus size={14} strokeWidth={2} />
          ) : (
            <Upload size={14} strokeWidth={2} />
          )}
          {a.label}
        </Link>
      ))}
    </div>
  );
}
