// QuickActions — the console's five most common entry points, one click from the
// dashboard head.

import { Link } from 'react-router-dom';
import { useConsolePath } from '@admin/services/consolePath';
import { Plus, Upload } from 'lucide-react';
import styles from '../DashboardPage.module.scss';

export default function QuickActions() {
  // The dashboard is the customer's landing page too (D16) — these five
  // targets must follow the mount or every quick action dead-ends at /account.
  const consolePath = useConsolePath();
  const actions = [
    { to: consolePath('/admin/parts/new'), label: 'Add Part', icon: 'plus' as const },
    { to: consolePath('/admin/suppliers/new'), label: 'Add Supplier', icon: 'plus' as const },
    { to: consolePath('/admin/sponsors/new'), label: 'New Sponsor', icon: 'plus' as const },
    { to: consolePath('/admin/expenses/new'), label: 'Log Expense', icon: 'plus' as const },
    { to: consolePath('/admin/import'), label: 'Import CSV', icon: 'upload' as const },
  ];
  return (
    <div className={styles.qaBar}>
      <span className={styles.qaTitle}>Quick actions</span>
      {actions.map((a) => (
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
